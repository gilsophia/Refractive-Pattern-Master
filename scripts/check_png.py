"""Validate Photoshop PNG exports. Does NOT measure vector width/gap or PSD layers.
Usage: python check_png.py EXPORT_DIRECTORY [--width N --height N]
Requires Pillow. Exits nonzero on any failed PNG or no PNGs.
"""
import argparse
import json
from pathlib import Path
from PIL import Image

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--width', type=int)
    parser.add_argument('--height', type=int)
    args = parser.parse_args()
    files = sorted(args.directory.glob('*.png'))
    results = []
    expected = None
    for file in files:
        with Image.open(file) as src:
            original_mode = src.mode
            has_alpha = 'A' in src.getbands() or 'transparency' in src.info
            dpi = src.info.get('dpi')
            im = src.convert('RGBA')
            expected = expected or im.size
            alpha = im.getchannel('A')
            hist = alpha.histogram()
            visible_nonblack = sum(1 for r, g, b, a in im.getdata() if a > 0 and (r or g or b))
            checks = {
                'has_alpha': has_alpha,
                'has_fully_transparent_pixels': hist[0] > 0,
                'has_fully_opaque_ink': hist[255] > 0,
                'visible_rgb_all_black': visible_nonblack == 0,
                'same_canvas_as_first': im.size == expected,
                'expected_width': args.width is None or im.width == args.width,
                'expected_height': args.height is None or im.height == args.height,
            }
            results.append({'file': file.name, 'mode': original_mode, 'size': im.size,
                            'dpi': dpi, 'visible_nonblack_pixels': visible_nonblack,
                            'checks': checks, 'pass': all(checks.values())})
    report = {'scope': 'PNG alpha, black pixels, nonempty ink and canvas only. No vector geometry or PSD editability proof.',
              'pass': bool(results) and all(r['pass'] for r in results), 'results': results}
    (args.directory / 'png_qa.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report['pass'] else 1)

if __name__ == '__main__':
    main()
