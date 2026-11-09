# Busy bot base: eve's sandbox image plus everything a bot's computer needs, built once for every bot.
# Rebuild and push with images/bot-base/push.sh, then bump BOT_BASE_IMAGE and BOT_BASE_IMAGE_VERSION
# in templates/bot/agent/sandbox.ts together.
FROM ghcr.io/vercel/eve:dockerfile-fc0279bf1664

USER root

# Office files, PDF tools, and the screen: Xvfb, openbox, the AT-SPI accessibility bus and Chrome.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      python3-pip libreoffice-calc libreoffice-writer libreoffice-gtk3 poppler-utils \
      xvfb openbox dbus-x11 at-spi2-core libatk-bridge2.0-0 x11-utils fonts-liberation fonts-dejavu wget xdg-utils \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/chrome.deb \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*
RUN pip3 install --break-system-packages -q python-docx openpyxl python-pptx pandas pypdf
# agent-desktop (vercel-labs): computer use over the accessibility tree.
RUN npm install -g --silent agent-desktop@1.0.2
# Stock browser client used by the guarded /usr/local/bin/browser wrappers. Keep
# it outside the bot's runtime dependencies; the native postinstall supplies the
# pinned Linux binary once while the image is built.
RUN mkdir -p /opt/busy-tools \
 && npm install --prefix /opt/busy-tools --silent agent-browser@0.41.1 \
 && test -x /opt/busy-tools/node_modules/agent-browser/bin/agent-browser-linux-x64 \
 && /opt/busy-tools/node_modules/agent-browser/bin/agent-browser-linux-x64 --version | grep -F '0.41.1'
# The live view in the hub's app: x11vnc shares the screen, websockify carries it to noVNC.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq x11vnc websockify \
 && rm -rf /var/lib/apt/lists/*
# A desktop to watch and use in the live screen: taskbar, file manager (and desktop icons), terminal.
# GTK loads icons through glycin, which sandboxes its loaders with bwrap. Every process in a Vercel
# Sandbox holds all capabilities, and bwrap refuses that unless it is setuid; glycin doesn't recognize
# the refusal, so the first SVG icon aborts the app. Setuid bwrap drops them and works.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tint2 pcmanfm lxterminal \
 && chmod u+s /usr/bin/bwrap \
 && rm -rf /var/lib/apt/lists/*
# desktop-a11y talks to the accessibility bus.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-dbus \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 desktop.sh /usr/local/bin/desktop
COPY --chmod=755 desktop-control.py /usr/local/bin/desktop-control
COPY --chmod=755 desktop-browser.py /usr/local/bin/desktop-browser
COPY --chmod=755 browser-wrapper.py /usr/local/bin/agent-browser
RUN ln -s /usr/local/bin/agent-browser /usr/local/bin/browser
COPY --chmod=755 desktop-a11y.py /usr/local/bin/desktop-a11y
COPY --chmod=755 desktop-live.sh /usr/local/bin/desktop-live
COPY --chmod=755 desktop-session.sh /usr/local/bin/desktop-session
COPY desktop /usr/local/share/busy-desktop
COPY --chmod=644 desktop-profile.sh /etc/profile.d/desktop.sh
# The image ABI marker the bot compares after opening a computer (templates/bot/agent/sandbox.ts,
# BOT_BASE_IMAGE_VERSION). Fixed before the build, so the image never needs its own digest; bump it
# whenever a wrapper or desktop contract changes, then publish and bump the digest and the constant.
COPY --chmod=644 image-version /etc/busy-image-version

# Back to the user eve's sandboxes run commands as.
USER vercel-sandbox
