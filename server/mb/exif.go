package mb

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
)

// Photos from a phone carry their GPS position, the camera and the time in Exif. A public board
// serves the original image to anyone, so StripJPEGMeta removes that metadata from a JPEG while it
// is streamed. Only the header before the picture data is rewritten; the picture bytes pass through
// untouched. The owner's stored file is not changed.

const maxJPEGHeader = 1 << 20 // a header larger than this is not a photo we serve

var errBadJPEG = errors.New("malformed JPEG header")

// StripJPEGMeta returns src without Exif, XMP, IPTC and comments. It keeps the colour profile and,
// as a minimal Exif block, the rotation (Orientation 2..8), so a phone photo does not turn sideways.
// A source that is not a JPEG comes back unchanged; a broken JPEG header is an error.
func StripJPEGMeta(src io.Reader) (io.Reader, error) {
	br := bufio.NewReaderSize(src, 64<<10)
	if magic, err := br.Peek(2); err != nil || magic[0] != 0xFF || magic[1] != 0xD8 {
		return br, nil
	}
	_, _ = br.Discard(2)

	var kept bytes.Buffer
	orientation := 0
	for {
		marker, err := nextMarker(br)
		if err != nil {
			return nil, err
		}
		switch {
		case marker == 0xDA || marker == 0xD9: // picture data (or end) starts: the header is done
			head := []byte{0xFF, 0xD8}
			if orientation >= 2 && orientation <= 8 {
				head = append(head, minimalExif(orientation)...)
			}
			head = append(head, kept.Bytes()...)
			head = append(head, 0xFF, marker)
			return io.MultiReader(bytes.NewReader(head), br), nil
		case marker == 0x01 || marker >= 0xD0 && marker <= 0xD7: // no payload
			kept.Write([]byte{0xFF, marker})
			continue
		}
		var lenb [2]byte
		if _, err := io.ReadFull(br, lenb[:]); err != nil {
			return nil, errBadJPEG
		}
		n := int(binary.BigEndian.Uint16(lenb[:])) - 2
		if n < 0 {
			return nil, errBadJPEG
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(br, payload); err != nil {
			return nil, errBadJPEG
		}
		switch marker {
		case 0xE1: // Exif or XMP: drop, remember the rotation
			if o := exifOrientation(payload); o != 0 && orientation == 0 {
				orientation = o
			}
		case 0xED, 0xFE: // IPTC / Photoshop, comment: drop
		default:
			kept.Write([]byte{0xFF, marker})
			kept.Write(lenb[:])
			kept.Write(payload)
		}
		if kept.Len() > maxJPEGHeader {
			return nil, errBadJPEG
		}
	}
}

// nextMarker reads the next marker byte, skipping the 0xFF fill bytes before it.
func nextMarker(br *bufio.Reader) (byte, error) {
	b, err := br.ReadByte()
	if err != nil || b != 0xFF {
		return 0, errBadJPEG
	}
	for {
		b, err = br.ReadByte()
		if err != nil {
			return 0, errBadJPEG
		}
		if b != 0xFF {
			if b == 0x00 {
				return 0, errBadJPEG
			}
			return b, nil
		}
	}
}

// exifOrientation reads the Orientation tag (0x0112) of an Exif APP1 payload; 0 when absent or unreadable.
func exifOrientation(p []byte) int {
	if !bytes.HasPrefix(p, []byte("Exif\x00\x00")) {
		return 0
	}
	t := p[6:]
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

// minimalExif is an APP1 segment holding only the Orientation tag (big-endian).
func minimalExif(o int) []byte {
	return append([]byte{0xFF, 0xE1, 0x00, 0x22},
		append([]byte("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00"),
			byte(o), 0, 0, 0, 0, 0, 0)...)
}
