#!/bin/sh
# Test Engine that refuses the handshake with the names of its environment
# variables as the message, so tests can check what an Engine process sees.
read -r _hello
names=$(env | sed 's/=.*//' | sort | tr '\n' ' ')
printf '{"type":"error","message":"%s"}\n' "$names"
read -r _quit
