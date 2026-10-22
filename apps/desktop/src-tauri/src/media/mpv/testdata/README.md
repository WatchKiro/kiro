# Test data

`seekable.mkv`: a 10 s, 128×72 H.264 video at 10 fps with a keyframe every
2 s, for the seek-bar preview tests (`preview.rs`). Made from ffmpeg's
`testsrc2` pattern:

```bash
ffmpeg -f lavfi -i "testsrc2=size=128x72:rate=10" -t 10 -c:v libx264 \
  -preset veryslow -crf 30 -g 20 -keyint_min 20 -sc_threshold 0 \
  -pix_fmt yuv420p -bsf:v filter_units=remove_types=6 seekable.mkv
```

`hls/`: the same video as HLS, five 2 s MPEG-TS segments (`seg0.ts` to
`seg4.ts`) listed in `media.m3u8`, remuxed without re-encoding:

```bash
ffmpeg -i seekable.mkv -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_filename 'hls/seg%d.ts' hls/media.m3u8
```

`hls/master.m3u8`, written by hand, names three variants: a 1080p and an
audio-only one whose playlists don't exist, and `media.m3u8`, the one with
the lowest bandwidth that has video, which previews must pick.
