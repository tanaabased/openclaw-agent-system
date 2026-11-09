import type { Mountable } from '@copilotkit/aimock';

// AIMock does not retain incremental Responses WebSocket history. Let native
// clients negotiate HTTP instead, without overriding their built-in providers.
const httpResponses: Mountable = {
  async handleRequest() {
    return false;
  },
  async handleUpgrade(socket) {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return true;
  },
};

export default httpResponses;
