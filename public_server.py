"""Opt-in local entrypoint for an explicitly requested temporary public tunnel.

No shared credentials, file fallback, or environment token is used. The browser
must send its own X-Auth-Key for each mutation; the RPC service validates it.
"""
import asyncio
import socket
from urllib.parse import urlsplit

import capnp
from flask import jsonify, request
from waitress import serve

import server
from rpc_tools.api_client import CVSE_Client, CVSE_capnp


class ExplicitKeyClient(CVSE_Client):
    def __init__(self, host, port, connection, client, cvse, auth_key=None):
        self.host = host
        self.port = port
        self.connection = connection
        self.client = client
        self.cvse = cvse
        self.auth_key = auth_key.strip() if isinstance(auth_key, str) and auth_key.strip() else None

    @staticmethod
    async def create(host, port, auth_key=None):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setblocking(False)
        try:
            await asyncio.wait_for(asyncio.get_running_loop().sock_connect(sock, (host, int(port))), 8)
            connection = await capnp.AsyncIoStream.create_connection(sock=sock)
            client = capnp.TwoPartyClient(connection)
            cvse = client.bootstrap().cast_as(CVSE_capnp.Cvse)
            return ExplicitKeyClient(host, port, connection, client, cvse, auth_key)
        except BaseException:
            sock.close()
            raise


server.CVSE_Client = ExplicitKeyClient
server.get_auth_key_from_request = lambda: request.headers.get('X-Auth-Key', '').strip() or None
app = server.app
app.config['MAX_CONTENT_LENGTH'] = 1024 * 1024


@app.before_request
def require_explicit_write_key():
    if 'auth_key' in request.args:
        return jsonify(success=False, error='Use X-Auth-Key header; credentials in URLs are disabled'), 400
    if request.method == 'POST' and request.path in {'/api/submit-changes', '/api/calculate-rankings'}:
        if not request.headers.get('X-Auth-Key', '').strip():
            return jsonify(success=False, error='A user-supplied X-Auth-Key is required; no server default exists'), 401
        origin = request.headers.get('Origin')
        if origin and urlsplit(origin).netloc != request.host:
            return jsonify(success=False, error='Cross-origin mutation is not permitted'), 403


@app.after_request
def public_response_safety(response):
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
        if response.status_code >= 500:
            response = jsonify(success=False, error='Backend request failed; check service connectivity or supplied authorization')
            response.status_code = 502
            response.headers['Cache-Control'] = 'no-store'
    return response


def cannot_validate_write_key():
    return jsonify(success=False, error='No read-only key-validation API exists. A read request cannot verify write authorization.'), 400


app.view_functions['validate_auth'] = cannot_validate_write_key

if __name__ == '__main__':
    print('Starting explicit-key CVSE instance on http://127.0.0.1:25125', flush=True)
    serve(app, host='127.0.0.1', port=25125, threads=4)
