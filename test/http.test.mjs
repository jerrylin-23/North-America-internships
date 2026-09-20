import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchJson } from '../providers/_http.mjs';

test('HTTP timeout covers a stalled response body', async () => {
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(fetchJson(`http://127.0.0.1:${server.address().port}`,{timeoutMs:100}),{name:'AbortError'});
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
