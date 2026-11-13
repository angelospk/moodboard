package mb

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
)

// Photos from a phone carry their GPS position, camera and time (Exif), and sometimes a second
// embedded picture. A public board serves the original image to anyone, so StripImageMeta removes
// that metadata from JPEG, PNG and WebP files before they leave the server. It works from an
// allowlist: only what is needed to show the picture stays. The owner's stored file is not changed.
// (GIF comments and AVIF/HEIC metadata are not handled.)

const maxStripBytes = maxImageBytes // the upload limit of the image field

var (
	errBadImage = errors.New("malformed image")
	pngSig      = []byte("\x89PNG\r\n\x1a\n")
)

// IsStrippable reports whether the file starting with head is a format StripImageMeta cleans.
func IsStrippable(head []byte) bool {
	return bytes.HasPrefix(head, []byte{0xFF, 0xD8}) || bytes.HasPrefix(head, pngSig) ||
		len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP"
}

// StripImageMeta returns src without location, camera, text and comment metadata. The format is
// found from the first bytes, not from a file name. Any other format comes back unchanged. A
// malformed JPEG, PNG or WebP is an error: it is never served half-cleaned.
func StripImageMeta(src io.Reader) (io.Reader, error) {
	b, err := io.ReadAll(io.LimitReader(src, maxStripBytes+1))
	if err != nil || len(b) > maxStripBytes {
		return nil, errBadImage
	}
	out := b
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8}):
		out, err = stripJPEG(b)
	case bytes.HasPrefix(b, pngSig):
		out, err = stripPNG(b)
	case IsStrippable(b):
		out, err = stripWebP(b)
	}
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(out), nil
}

// ---- JPEG ----

// stripJPEG keeps SOI, the tables and frame headers, the scans, a JFIF header without thumbnail, an
// ICC profile, an Adobe colour tag, and (if the file has a rotation) a minimal Exif with only
// Orientation. Everything else is dropped: other APPn, comments, and any data after the first EOI.
func stripJPEG(b []byte) ([]byte, error) {
	rest := make([]byte, 0, len(b))
	orientation := 0
	i := 2
	for {
		if i >= len(b) || b[i] != 0xFF {
			return nil, errBadImage
		}
		for i < len(b) && b[i] == 0xFF { // fill bytes
			i++
		}
		if i >= len(b) {
			return nil, errBadImage
		}
		m := b[i]
		i++
		switch {
		case m == 0xD9: // EOI: whatever follows (a preview, a video) is not served
			out := []byte{0xFF, 0xD8}
			if orientation >= 2 && orientation <= 8 {
				out = append(out, minimalExif(orientation)...)
			}
			out = append(out, rest...)
			return append(out, 0xFF, 0xD9), nil
		case m == 0x00 || m == 0x01 || m >= 0xD0 && m <= 0xD8: // never valid between segments
			return nil, errBadImage
		}
		if i+2 > len(b) {
			return nil, errBadImage
		}
		n := int(b[i])<<8 | int(b[i+1])
		if n < 2 || i+n > len(b) {
			return nil, errBadImage
		}
		payload := b[i+2 : i+n]
		seg := b[i-2 : i+n] // FF marker length payload
		i += n

		switch {
		case m == 0xDA: // SOS: the segment, then the entropy-coded data up to the next real marker
			rest = append(rest, seg...)
			j := i
			for j < len(b) {
				k := bytes.IndexByte(b[j:], 0xFF)
				if k < 0 {
					j = len(b)
					break
				}
				j += k
				if j+1 >= len(b) {
					j = len(b)
					break
				}
				nx := b[j+1]
				if nx == 0x00 || nx >= 0xD0 && nx <= 0xD7 { // stuffed byte, restart marker
					j += 2
					continue
				}
				if nx == 0xFF { // fill
					j++
					continue
				}
				break
			}
			rest = append(rest, b[i:j]...)
			i = j
		case m == 0xE1: // Exif / XMP: drop, keep only the rotation
			if o := exifOrientation(payload); o != 0 && orientation == 0 {
				orientation = o
			}
		case m == 0xE0: // JFIF without its embedded thumbnail; JFXX and others go
			if len(payload) >= 14 && bytes.HasPrefix(payload, []byte("JFIF\x00")) {
				rest = append(rest, 0xFF, 0xE0, 0x00, 0x10)
				rest = append(rest, payload[:12]...)
				rest = append(rest, 0, 0)
			}
		case m == 0xE2: // only the ICC colour profile
			if bytes.HasPrefix(payload, []byte("ICC_PROFILE\x00")) {
				rest = append(rest, seg...)
			}
		case m == 0xEE: // only the Adobe colour transform tag
			if len(payload) <= 16 && bytes.HasPrefix(payload, []byte("Adobe")) {
				rest = append(rest, seg...)
			}
		case m >= 0xE3 && m <= 0xEF || m == 0xFE: // other APPn, IPTC, comments
		default: // DQT, DHT, SOFn, DRI, ...
			rest = append(rest, seg...)
		}
	}
}

// exifOrientation reads the Orientation tag (0x0112) of an Exif APP1 payload; 0 when absent or unreadable.
func exifOrientation(p []byte) int {
	if !bytes.HasPrefix(p, []byte("Exif\x00\x00")) {
		return 0
	}
	return tiffOrientation(p[6:])
}

// tiffOrientation reads the Orientation tag from a bare TIFF block (what PNG eXIf and WebP EXIF
// hold; WebP writers sometimes put the "Exif\0\0" prefix in front, which is skipped).
func tiffOrientation(t []byte) int {
	t = bytes.TrimPrefix(t, []byte("Exif\x00\x00"))
	if len(t) < 8 {
		return 0
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0
	}
	if bo.Uint16(t[2:4]) != 42 {
		return 0
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 0
	}
	count := int(bo.Uint16(t[off : off+2]))
	for i := 0; i < count; i++ {
		e := off + 2 + i*12
		if e+12 > len(t) {
			return 0
		}
		if bo.Uint16(t[e:e+2]) == 0x0112 {
			if bo.Uint16(t[e+2:e+4]) != 3 || bo.Uint32(t[e+4:e+8]) != 1 {
				return 0
			}
			return int(bo.Uint16(t[e+8 : e+10]))
		}
	}
	return 0
}

// minimalTIFF is a TIFF block holding only the Orientation tag (big-endian), 26 bytes.
func minimalTIFF(o int) []byte {
	return append([]byte("MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00"),
		byte(o), 0, 0, 0, 0, 0, 0)
}

// minimalExif is a JPEG APP1 segment holding only the Orientation tag.
func minimalExif(o int) []byte {
	return append([]byte{0xFF, 0xE1, 0x00, 0x22}, append([]byte("Exif\x00\x00"), minimalTIFF(o)...)...)
}

// ---- PNG ----

// pngKeep lists the chunks that matter for showing the image. eXIf, tEXt, zTXt, iTXt, tIME and
// unknown ancillary chunks are dropped; an unknown critical chunk (capital first letter) stays.
var pngKeep = map[string]bool{
	"IHDR": true, "PLTE": true, "IDAT": true, "IEND": true, "tRNS": true, "gAMA": true, "cHRM": true,
	"sRGB": true, "iCCP": true, "sBIT": true, "bKGD": true, "hIST": true, "pHYs": true, "sPLT": true,
	"acTL": true, "fcTL": true, "fdAT": true, "cICP": true, "mDCV": true, "cLLI": true,
}

func stripPNG(b []byte) ([]byte, error) {
	out := append([]byte{}, pngSig...)
	i := len(pngSig)
	for {
		if i+12 > len(b) {
			return nil, errBadImage
		}
		n := int(binary.BigEndian.Uint32(b[i : i+4]))
		if n < 0 || n > len(b) || i+12+n > len(b) {
			return nil, errBadImage
		}
		typ := string(b[i+4 : i+8])
		if pngKeep[typ] || typ[0] >= 'A' && typ[0] <= 'Z' {
			out = append(out, b[i:i+12+n]...)
		}
		if typ == "IHDR" { // a kept rotation goes right after IHDR, before IDAT
			out = append(out, pngRotationChunk(b, i+12+n)...)
		}
		i += 12 + n
		if typ == "IEND" { // anything after IEND is not served
			return out, nil
		}
	}
}

// ---- WebP ----

func stripWebP(b []byte) ([]byte, error) {
	size := int(binary.LittleEndian.Uint32(b[4:8]))
	if size < 4 || size+8 > len(b) {
		return nil, errBadImage
	}
	end := size + 8
	body := []byte("WEBP")
	orientation := 0
	vp8x := -1 // offset of the VP8X chunk inside body
	i := 12
	for i < end {
		if i+8 > end {
			return nil, errBadImage
		}
		fourcc := string(b[i : i+4])
		n := int(binary.LittleEndian.Uint32(b[i+4 : i+8]))
		total := 8 + n + n%2 // payload is padded to an even size
		if n < 0 || i+total > end {
			return nil, errBadImage
		}
		chunk := b[i : i+total]
		i += total
		switch fourcc {
		case "EXIF":
			if orientation == 0 {
				orientation = tiffOrientation(chunk[8 : 8+n])
			}
			continue
		case "XMP ":
			continue
		case "VP8X":
			if n >= 1 {
				chunk = append([]byte{}, chunk...)
				vp8x = len(body)
			}
		}
		body = append(body, chunk...)
	}
	if vp8x >= 0 {
		body[vp8x+8] &^= 0x08 | 0x04 // clear the EXIF and XMP flags ...
		if orientation >= 2 && orientation <= 8 {
			body = append(body, riffChunk("EXIF", minimalTIFF(orientation))...) // ... then keep only the rotation
			body[vp8x+8] |= 0x08
		}
	}
	out := append([]byte("RIFF\x00\x00\x00\x00"), body...)
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(body)))
	return out, nil
}

// pngRotationChunk looks ahead from `from` for an eXIf chunk and returns a minimal one with only
// its Orientation (2..8), or nothing.
func pngRotationChunk(b []byte, from int) []byte {
	for i := from; i+12 <= len(b); {
		n := int(binary.BigEndian.Uint32(b[i : i+4]))
		if n > len(b) || i+12+n > len(b) {
			return nil
		}
		typ := string(b[i+4 : i+8])
		if typ == "eXIf" {
			if r := tiffOrientation(b[i+8 : i+8+n]); r >= 2 && r <= 8 {
				data := minimalTIFF(r)
				var c bytes.Buffer
				_ = binary.Write(&c, binary.BigEndian, uint32(len(data)))
				c.WriteString("eXIf")
				c.Write(data)
				_ = binary.Write(&c, binary.BigEndian, crc32.ChecksumIEEE(append([]byte("eXIf"), data...)))
				return c.Bytes()
			}
			return nil
		}
		if typ == "IDAT" || typ == "IEND" {
			return nil
		}
		i += 12 + n
	}
	return nil
}

// riffChunk builds one RIFF chunk: fourcc, little-endian size, payload, padding to an even size.
func riffChunk(fourcc string, payload []byte) []byte {
	c := append([]byte(fourcc), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(c[4:], uint32(len(payload)))
	c = append(c, payload...)
	if len(payload)%2 == 1 {
		c = append(c, 0)
	}
	return c
}
