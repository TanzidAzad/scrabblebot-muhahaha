#!/bin/sh
# Keeps the bot running: restarts it whenever it stops or gets disconnected.
#   ./run.sh            (uses BOT_NAME=muhahaha)
cd "$(dirname "$0")"
NAME="${BOT_NAME:-muhahaha}"
while true; do
  BOT_NAME="$NAME" npm start
  echo "bot stopped; restarting in 5s (Ctrl+C twice to quit)"
  sleep 5
done
