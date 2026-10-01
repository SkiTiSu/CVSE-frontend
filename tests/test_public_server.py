"""Safety checks for public entrypoint. No test connects to a live RPC endpoint."""
import unittest
import asyncio
from unittest.mock import AsyncMock, patch

import public_server


class PublicEntrypointTests(unittest.TestCase):
    def test_stalled_read_is_cancelled(self):
        cancelled = []
        async def stalled():
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.append(True)
        with self.assertRaises(TimeoutError):
            asyncio.run(public_server.bounded_read(stalled, timeout=0.01)())
        self.assertEqual(cancelled, [True])

    def test_busy_rpc_does_not_block_health_and_missing_key(self):
        public_server.read_slots.acquire()
        try:
            with patch.object(public_server.ExplicitKeyClient, 'create', new_callable=AsyncMock) as rpc:
                self.assertEqual(self.client.get('/api/videos').status_code, 503)
                self.assertEqual(self.client.get('/api/health').status_code, 200)
                self.assertEqual(self.client.post('/api/submit-changes', json={}).status_code, 401)
                rpc.assert_not_called()
        finally:
            public_server.read_slots.release()

    def test_stalled_write_lane_does_not_block_read_lane(self):
        public_server.write_slots.acquire()
        try:
            with patch.object(public_server.server, 'get_videos_async', new_callable=AsyncMock, return_value={"data": [], "total": 0}), patch.object(public_server.server, 'submit_changes_async', new_callable=AsyncMock) as submit:
                self.assertEqual(self.client.get('/api/videos').status_code, 200)
                self.assertEqual(self.client.post('/api/submit-changes', json={}, headers={'X-Auth-Key': 'fixture-only'}).status_code, 503)
                submit.assert_not_called()
        finally:
            public_server.write_slots.release()

    def test_slot_released_after_failed_read(self):
        with patch.object(public_server.server, 'get_videos_async', new_callable=AsyncMock, side_effect=TimeoutError):
            for _ in range(3):
                self.assertEqual(self.client.get('/api/videos').status_code, 502)

    def setUp(self):
        public_server.server.limiter.enabled = False
        self.client = public_server.app.test_client()

    def test_missing_and_blank_keys_never_reach_rpc(self):
        for route in ['/api/submit-changes', '/api/calculate-rankings']:
            for headers in [{}, {'X-Auth-Key': '   '}]:
                with patch.object(public_server.ExplicitKeyClient, 'create', new_callable=AsyncMock) as rpc:
                    response = self.client.post(route, json={'changes': []}, headers=headers)
                    self.assertEqual(response.status_code, 401)
                    rpc.assert_not_called()

    def test_no_file_or_environment_key_fallback(self):
        with patch('builtins.open', side_effect=AssertionError('Credential files must not be read')):
            client = public_server.ExplicitKeyClient('fixture', 0, None, None, None)
            self.assertIsNone(client.auth_key)
            client = public_server.ExplicitKeyClient('fixture', 0, None, None, None, ' fixture-only ')
            self.assertEqual(client.auth_key, 'fixture-only')

    def test_query_credentials_rejected(self):
        response = self.client.get('/api/health?auth_key=fixture-only')
        self.assertEqual(response.status_code, 400)

    def test_explicit_key_passed_only_to_mocked_mutation(self):
        with patch.object(public_server.server, 'submit_changes_async', new_callable=AsyncMock, return_value=1) as submit:
            response = self.client.post('/api/submit-changes', json={'changes': [{'bvid': 'fixture'}]}, headers={'X-Auth-Key': 'fixture-only'})
            self.assertEqual(response.status_code, 200)
            submit.assert_awaited_once_with([{'bvid': 'fixture'}], 'fixture-only')

    def test_cross_origin_writes_rejected_before_rpc(self):
        with patch.object(public_server.ExplicitKeyClient, 'create', new_callable=AsyncMock) as rpc:
            response = self.client.post('/api/submit-changes', json={'changes': []}, headers={'X-Auth-Key': 'fixture-only', 'Origin': 'https://other.invalid'})
            self.assertEqual(response.status_code, 403)
            rpc.assert_not_called()

    def test_validation_does_not_claim_key_valid_or_connect(self):
        with patch.object(public_server.ExplicitKeyClient, 'create', new_callable=AsyncMock) as rpc:
            response = self.client.post('/api/auth/validate', json={'auth_key': 'fixture-only'})
            self.assertEqual(response.status_code, 400)
            self.assertFalse(response.json['success'])
            rpc.assert_not_called()
