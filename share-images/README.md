# Share images (OG cards)

Source HTML for per-page share images. Not served (lives outside docs/).

Render at 1200x630, then export to docs/assets/:

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars \
      --window-size=1200,630 --virtual-time-budget=6000 --screenshot=og-yoto.png "file://$PWD/og-yoto.html"
    sips -s format jpeg -s formatOptions 88 og-yoto.png --out ../docs/assets/og-yoto.jpg

Fonts load from Google Fonts over the network (works for screenshots; the virtual-time budget gives them time to arrive).
