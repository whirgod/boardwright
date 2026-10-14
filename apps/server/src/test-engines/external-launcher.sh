#!/bin/sh
# Test launcher that does NOT `exec`: the test Engine (external.ts) runs as a
# grandchild of the server and inherits the pipes. The server must still be
# able to stop it and close (see EngineProcess.kill in external-engine.ts).
"$(dirname "$0")/external.ts" "$@"
