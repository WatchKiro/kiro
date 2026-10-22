# Test data

`seekable.mkv`: a 10 s, 128×72 H.264 video at 10 fps with a keyframe every
2 s, for the seek-bar preview tests (`preview.rs`). Made from ffmpeg's
`testsrc2` pattern:

```bash
ffmpeg -f lavfi -i "testsrc2=size=128x72:rate=10" -t 10 -c:v libx264 \
  -preset veryslow -crf 30 -g 20 -keyint_min 20 -sc_threshold 0 \
  -pix_fmt yuv420p -bsf:v filter_units=remove_types=6 seekable.mkv
```
