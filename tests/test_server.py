"""Offline API regression tests. Every CVSE RPC client is mocked."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import server
from rpc_tools.api_client import CVSE_capnp


def video(number, *, republish=False, examined=True, ranks=("domestic",), **overrides):
    values = {
        "avid": str(number),
        "bvid": f"BV{number}",
        "title": f"Video {number}",
        "uploader": "Singer",
        "upFace": "",
        "cover": f"https://example.test/{number}.jpg",
        "pubdate": SimpleNamespace(seconds=1770000000, nanoseconds=0),
        "duration": 120,
        "tags": ["music"],
        "desc": "A song",
        "ranks": [SimpleNamespace(value=value) for value in ranks],
        "isExamined": examined,
        "isRepublish": republish,
        "staffInfo": "",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def ranking(number, rank, special="normal"):
    # Use the real schema to test enum-to-JSON handling without any RPC calls.
    return CVSE_capnp.Cvse.RankingInfoEntry.new_message(
        avid=str(number),
        bvid=f"BV{number}",
        rank=rank,
        specialRank=special,
        view=100 + number,
        like=20 + number,
        coin=10 + number,
        favorite=30 + number,
        share=5 + number,
        reply=7 + number,
        danmaku=9 + number,
        totalScore=150.5 + number,
        isNew=number % 2 == 0,
    )


class MockRPCMixin:
    def setUp(self):
        super().setUp()
        self.client = SimpleNamespace(
            getAll=AsyncMock(return_value=[]),
            lookupMetaInfo=AsyncMock(return_value=[]),
            lookupRankingMetaInfo=AsyncMock(),
            getAllRankingInfo=AsyncMock(return_value=[]),
            lookupRankingInfo=AsyncMock(return_value=[]),
        )
        self.create_patch = patch.object(
            server.CVSE_Client, "create", new_callable=AsyncMock, return_value=self.client
        )
        self.create = self.create_patch.start()
        self.addCleanup(self.create_patch.stop)

    def set_videos(self, videos):
        self.client.getAll.return_value = [
            SimpleNamespace(avid=item.avid, bvid=item.bvid) for item in videos
        ]
        self.client.lookupMetaInfo.return_value = videos

    def set_rankings(self, entries, *, missing=()):
        self.client.lookupRankingMetaInfo.return_value = SimpleNamespace(
            count=len(entries),
            totalView=1000,
            totalLike=200,
            totalCoin=100,
            totalFavorite=300,
            totalNew=2,
        )
        self.indices = {
            entry.bvid: SimpleNamespace(avid=entry.avid, bvid=entry.bvid)
            for entry in entries
        }
        self.ranked_entries = {entry.bvid: entry for entry in entries}

        async def get_indices(rank, index, contain_unexamined, from_rank, to_rank):
            # Mirror the documented half-open rank interval, including rank 0.
            return [
                self.indices[entry.bvid]
                for entry in entries
                if from_rank <= entry.rank < to_rank
            ]

        async def lookup_entries(rank, index, contain_unexamined, indices):
            return [
                self.ranked_entries[item.bvid]
                for item in indices
                if item.bvid not in missing
            ]

        async def lookup_metadata(indices):
            return [video(int(item.avid)) for item in indices]

        self.client.getAllRankingInfo.side_effect = get_indices
        self.client.lookupRankingInfo.side_effect = lookup_entries
        self.client.lookupMetaInfo.side_effect = lookup_metadata

    def mixed_rankings(self):
        # Deliberately out of order, with both special types interleaved.
        return [
            ranking(3, 3),
            ranking(5, 0, "hot"),
            ranking(1, 1),
            ranking(6, 0, "sh"),
            ranking(4, 4),
            ranking(2, 2),
        ]


class VideoFilterTests(MockRPCMixin, unittest.IsolatedAsyncioTestCase):
    async def fetch(self, **overrides):
        params = dict(
            keyword="",
            rank_filter="all",
            examined="",
            bvid="",
            avid="",
            page=1,
            page_size=2,
            date_str="2026-09-01",
            auth_key="test-key",
        )
        params.update(overrides)
        return await server.get_videos_async(**params)

    async def test_republish_filter_is_applied_before_pagination_and_stats(self):
        self.set_videos([
            video(1),
            video(2, republish=True),
            video(3),
            video(4, republish=True, examined=False, ranks=("sv",)),
            video(5, republish=True, ranks=("domestic", "utau")),
        ])
        first = await self.fetch(is_republish="true")
        second = await self.fetch(is_republish="true", page=2)
        self.assertEqual([item["bvid"] for item in first["data"]], ["BV2", "BV4"])
        self.assertEqual([item["bvid"] for item in second["data"]], ["BV5"])
        self.assertEqual(first["total"], 3)
        self.assertEqual(first["stats"], {
            "total": 3, "domestic": 2, "sv": 1, "utau": 1,
            "republish": 3, "uncheck": 1, "exclusion": 0,
        })
        self.assertEqual(second["stats"], first["stats"])

    async def test_false_selects_only_original_videos(self):
        self.set_videos([video(1, republish=True), video(2), video(3)])
        result = await self.fetch(is_republish="false")
        self.assertEqual([item["bvid"] for item in result["data"]], ["BV2", "BV3"])
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["stats"]["republish"], 0)

    async def test_empty_republish_filter_preserves_existing_results(self):
        self.set_videos([video(1), video(2, republish=True), video(3)])
        result = await self.fetch(is_republish="")
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["stats"]["republish"], 1)
        self.assertEqual([item["bvid"] for item in result["data"]], ["BV1", "BV2"])

    async def test_republish_combines_with_keyword_rank_and_review_filters(self):
        self.set_videos([
            video(1, republish=True, title="Target"),
            video(2, title="Target"),
            video(3, republish=True, title="Target", examined=False),
            video(4, republish=True, title="Other"),
            video(5, republish=True, title="Target", ranks=("sv",)),
        ])
        result = await self.fetch(
            is_republish="true", keyword="target", rank_filter="domestic", examined="yes"
        )
        self.assertEqual([item["bvid"] for item in result["data"]], ["BV1"])
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["stats"]["total"], 1)

    async def test_republish_combines_with_id_filters(self):
        self.set_videos([video(12, republish=True), video(21, republish=True), video(123)])
        result = await self.fetch(is_republish="true", bvid="bv12", avid="12")
        self.assertEqual([item["bvid"] for item in result["data"]], ["BV12"])

    async def test_no_matching_videos_returns_zero_stats(self):
        self.set_videos([video(1), video(2)])
        result = await self.fetch(is_republish="true")
        self.assertEqual(result["data"], [])
        self.assertEqual(result["total"], 0)
        self.assertTrue(all(value == 0 for value in result["stats"].values()))

    async def test_empty_source_does_not_lookup_metadata(self):
        result = await self.fetch(is_republish="true")
        self.assertEqual(result["total"], 0)
        self.client.lookupMetaInfo.assert_not_awaited()


class RankingPreviewTests(MockRPCMixin, unittest.IsolatedAsyncioTestCase):
    async def fetch(self, **overrides):
        params = dict(
            rank_name="domestic", index=12, contain_unexamined=True,
            auth_key="test-key", page=1, page_size=2,
        )
        params.update(overrides)
        return await server.get_ranking_preview_async(**params)

    async def test_preview_uses_remote_page_bounds_and_unfiltered_total(self):
        self.set_rankings(self.mixed_rankings())
        first = await self.fetch()
        second = await self.fetch(page=2)
        self.assertEqual([entry["rank"] for entry in first["entries"]], [1, 2])
        self.assertEqual([entry["rank"] for entry in second["entries"]], [3, 4])
        self.assertEqual(first["total"], 6)
        self.assertEqual(second["total"], 6)
        self.assertEqual(first["stat"]["totalView"], 1000)
        self.assertEqual([call.args[3:] for call in self.client.getAllRankingInfo.await_args_list], [(1, 3), (3, 5)])
        self.create.assert_awaited_with(server.CVSE_HOST, server.CVSE_PORT, "test-key")

    async def test_show_special_is_compatible_without_fetching_rank_zero(self):
        self.set_rankings(self.mixed_rankings())
        hidden = await self.fetch(show_special=False)
        shown = await self.fetch(show_special=True)
        self.assertEqual(hidden, shown)
        self.assertEqual([entry["rank"] for entry in shown["entries"]], [1, 2])
        self.assertTrue(all(call.args[3] >= 1 for call in self.client.getAllRankingInfo.await_args_list))

    async def test_page_specials_are_returned_without_filtering_or_refill(self):
        self.set_rankings([ranking(1, 1, "hot"), ranking(2, 2, "sh"), ranking(3, 3)])
        result = await self.fetch(show_special=False)
        self.assertEqual([entry["specialRank"] for entry in result["entries"]], ["hot", "sh"])
        self.assertEqual(result["total"], 3)
        self.client.getAllRankingInfo.assert_awaited_once_with(server.Rank.DOMESTIC, 12, True, 1, 3)
        self.assertEqual(len(self.client.lookupRankingInfo.await_args.args[3]), 2)

    async def test_preview_exposes_reply_danmaku_and_json_safe_special_rank(self):
        self.set_rankings([ranking(1, 1)])
        result = await self.fetch()
        entry = result["entries"][0]
        self.assertEqual(entry["reply"], 8)
        self.assertEqual(entry["danmaku"], 10)
        self.assertEqual(entry["specialRank"], "normal")
        self.assertEqual(entry["title"], "Video 1")
        self.assertEqual(entry["totalScore"], 151.5)

    async def test_metadata_is_looked_up_only_for_the_visible_page(self):
        self.set_rankings(self.mixed_rankings())
        await self.fetch(page=2)
        indices = self.client.lookupMetaInfo.await_args.args[0]
        self.assertEqual({entry.bvid for entry in indices}, {"BV3", "BV4"})

    async def test_missing_page_entries_are_not_refilled_and_keep_upstream_total(self):
        self.set_rankings(self.mixed_rankings(), missing={"BV1"})
        result = await self.fetch()
        self.assertEqual(result["total"], 6)
        self.assertEqual([entry["rank"] for entry in result["entries"]], [2])
        self.client.getAllRankingInfo.assert_awaited_once()

    async def test_rank_zero_entries_are_not_requested_but_total_is_preserved(self):
        self.set_rankings([ranking(1, 0, "sh"), ranking(2, 0, "hot")])
        result = await self.fetch()
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["stat"]["count"], 2)
        self.client.lookupMetaInfo.assert_not_awaited()

    async def test_empty_rank_interval_keeps_upstream_total(self):
        self.set_rankings(self.mixed_rankings())
        result = await self.fetch(page=3)
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["total"], 6)
        self.assertEqual(result["page"], 3)
        self.assertEqual(result["page_size"], 2)
        self.client.lookupMetaInfo.assert_not_awaited()

    async def test_empty_ranking_has_consistent_pagination_fields(self):
        self.set_rankings([])
        result = await self.fetch(page=2, page_size=10)
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["page"], 2)
        self.assertEqual(result["page_size"], 10)
        self.client.getAllRankingInfo.assert_not_awaited()

    async def test_missing_calculation_has_consistent_pagination_fields(self):
        self.client.lookupRankingMetaInfo.side_effect = RuntimeError("No cached calculation")
        with self.assertLogs(level="WARNING"):
            result = await self.fetch(page=2, page_size=10)
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["page"], 2)
        self.assertEqual(result["page_size"], 10)
        self.client.getAllRankingInfo.assert_not_awaited()

    async def test_empty_index_lookup_skips_detail_requests(self):
        self.set_rankings([ranking(1, 1)])
        self.client.getAllRankingInfo.side_effect = None
        self.client.getAllRankingInfo.return_value = []
        result = await self.fetch()
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["total"], 1)
        self.client.lookupRankingInfo.assert_not_awaited()
        self.client.lookupMetaInfo.assert_not_awaited()

    async def test_large_ranking_reads_only_twenty_details(self):
        self.set_rankings([ranking(number, number) for number in range(1, 4101)])
        result = await self.fetch(page=205, page_size=20)
        self.assertEqual(result["total"], 4100)
        self.assertEqual([entry["rank"] for entry in result["entries"]], list(range(4081, 4101)))
        self.client.getAllRankingInfo.assert_awaited_once_with(server.Rank.DOMESTIC, 12, True, 4081, 4101)
        self.assertEqual([len(call.args[3]) for call in self.client.lookupRankingInfo.await_args_list], [20])
        self.assertEqual(len(self.client.lookupMetaInfo.await_args.args[0]), 20)


    async def test_include_special_queries_only_zero_interval_separately(self):
        self.set_rankings(self.mixed_rankings())
        result = await self.fetch(include_special=True)
        self.assertEqual([entry["rank"] for entry in result["entries"]], [1, 2])
        self.assertEqual({entry["special_rank"] for entry in result["special_entries"]}, {"hot", "sh"})
        self.assertTrue(all(entry["rank"] == 0 for entry in result["special_entries"]))
        self.assertFalse(result["special_truncated"])
        self.assertEqual([call.args[3:] for call in self.client.getAllRankingInfo.await_args_list], [(1, 3), (0, 1)])
        self.assertTrue(all(len(call.args[3]) <= 100 for call in self.client.lookupRankingInfo.await_args_list))
        self.assertTrue(all(len(call.args[0]) <= 100 for call in self.client.lookupMetaInfo.await_args_list))

    async def test_special_reader_is_bounded_before_materializing_and_details(self):
        self.set_rankings([ranking(1, 1)] + [ranking(number, 0, "hot") for number in range(2, 152)])
        accesses = []
        special_indices = [self.indices[f"BV{number}"] for number in range(2, 152)]

        class BoundedReader:
            def __len__(self):
                return len(special_indices)

            def __iter__(self):
                raise AssertionError("Do not materialize the entire special index reader")

            def __getitem__(self, index):
                if not isinstance(index, int) or not 0 <= index < 100:
                    raise AssertionError("Special reader accessed beyond the 100-entry cap")
                accesses.append(index)
                return special_indices[index]

        original = self.client.getAllRankingInfo.side_effect
        async def bounded_indices(rank, index, contain_unexamined, start, stop):
            if (start, stop) == (0, 1):
                return BoundedReader()
            return await original(rank, index, contain_unexamined, start, stop)
        self.client.getAllRankingInfo.side_effect = bounded_indices
        result = await self.fetch(include_special=True)
        self.assertTrue(result["special_truncated"])
        self.assertEqual(len(result["special_entries"]), 100)
        self.assertEqual(accesses, list(range(100)))
        self.assertEqual([len(call.args[3]) for call in self.client.lookupRankingInfo.await_args_list], [1, 100])
        self.assertEqual([len(call.args[0]) for call in self.client.lookupMetaInfo.await_args_list], [1, 100])
        self.assertEqual([call.args[3:] for call in self.client.getAllRankingInfo.await_args_list], [(1, 3), (0, 1)])

    async def test_special_empty_interval_skips_extra_detail_lookup(self):
        self.set_rankings([ranking(1, 1)])
        result = await self.fetch(include_special=True)
        self.assertEqual(result["special_entries"], [])
        self.assertFalse(result["special_truncated"])
        self.client.lookupRankingInfo.assert_awaited_once()
        self.client.lookupMetaInfo.assert_awaited_once()
        self.assertEqual([call.args[3:] for call in self.client.getAllRankingInfo.await_args_list], [(1, 2), (0, 1)])


class ApiRouteTests(MockRPCMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.limiter_patch = patch.object(server.limiter, "enabled", False)
        self.limiter_patch.start()
        self.addCleanup(self.limiter_patch.stop)
        self.http = server.app.test_client()

    def test_video_route_passes_false_republish_filter(self):
        self.set_videos([video(1, republish=True), video(2)])
        response = self.http.get("/api/videos?is_republish=false&date=2026-09-01")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["data"][0]["bvid"], "BV2")

    def test_video_route_normalizes_true_filter(self):
        self.set_videos([video(1, republish=True), video(2)])
        response = self.http.get("/api/videos?is_republish=TRUE&date=2026-09-01")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["data"][0]["bvid"], "BV1")

    def test_video_route_omitted_or_empty_filter_includes_all_videos(self):
        self.set_videos([video(1, republish=True), video(2)])
        for suffix in ("", "&is_republish="):
            with self.subTest(suffix=suffix):
                response = self.http.get("/api/videos?date=2026-09-01" + suffix)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()["total"], 2)

    def test_invalid_republish_filter_is_rejected_without_rpc(self):
        response = self.http.get("/api/videos?is_republish=maybe")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["success"])
        self.create.assert_not_awaited()

    def test_preview_route_returns_upstream_total(self):
        self.set_rankings(self.mixed_rankings())
        response = self.http.get("/api/ranking-preview?index=12&page_size=2")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["data"]["total"], 6)
        self.assertEqual([entry["rank"] for entry in payload["data"]["entries"]], [1, 2])

    def test_preview_route_special_parameter_does_not_expand_request(self):
        self.set_rankings([ranking(1, 1, "hot"), ranking(2, 2), ranking(3, 0, "sh")])
        for value in ("true", "false"):
            with self.subTest(show_special=value):
                response = self.http.get(f"/api/ranking-preview?show_special={value}&page_size=2")
                self.assertEqual(response.status_code, 200)
                payload = response.get_json()["data"]
                self.assertEqual(payload["total"], 3)
                self.assertEqual([entry["rank"] for entry in payload["entries"]], [1, 2])
                self.assertEqual(payload["entries"][0]["specialRank"], "hot")
        self.assertTrue(all(call.args[3:] == (1, 3) for call in self.client.getAllRankingInfo.await_args_list))

    def test_include_special_route_passes_explicit_option(self):
        self.set_rankings(self.mixed_rankings())
        response = self.http.get("/api/ranking-preview?index=12&page_size=2&include_special=true")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()["data"]
        self.assertEqual({entry["special_rank"] for entry in data["special_entries"]}, {"hot", "sh"})
        self.assertEqual([call.args[3:] for call in self.client.getAllRankingInfo.await_args_list], [(1, 3), (0, 1)])

    def test_invalid_preview_pagination_is_rejected_before_rpc(self):
        for query in ("page=0", "page=-1", "page_size=0", "page_size=-1", "page_size=101", "page=invalid", "page_size=invalid"):
            with self.subTest(query=query):
                response = self.http.get("/api/ranking-preview?" + query)
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.get_json()["success"])
        self.create.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
