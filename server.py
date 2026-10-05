#!/usr/bin/env python3
"""
CVSE Web Server - Enhanced Version
Supports recording, preview, API debugging, offline changes

Copyright (c) 2026 milkboy, yhtq
"""

import asyncio
import logging
import os
import re
import hashlib
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from datetime import date, datetime, timedelta

import aiohttp
import capnp
import requests
from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from waitress import serve

from rpc_tools.api_client import (
    CVSE_Client,
    Index_to_capnp,
    ModifyEntry,
    ModifyEntry_to_capnp,
    Rank,
    RPCTime,
    bv_to_index,
    av_to_index,
    capnp_to_Rank,
)

app = Flask(__name__)
CORS(app)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["100 per minute"],
)

CVSE_HOST = "47.104.91.74"
CVSE_PORT = "8663"

# Only detached ID strings are shared across requests/event loops, never RPC readers.
PREVIEW_INDEX_TTL = 300
PREVIEW_INDEX_LIMIT = 200_000
_preview_indices = OrderedDict()
_preview_index_pending = {}
_preview_index_lock = threading.Lock()
_preview_index_epoch = 0


def invalidate_preview_indices():
    global _preview_index_epoch
    with _preview_index_lock:
        _preview_index_epoch += 1
        _preview_indices.clear()


async def get_preview_indices(client, rank, index, contain_unexamined, auth_key, stat):
    """Reuse the upstream rank-ordered ID snapshot; ties occupy separate row slots."""
    signature = tuple(getattr(stat, field) for field in
                      ("count", "totalView", "totalLike", "totalCoin", "totalFavorite", "totalNew"))
    identity = (rank.name, index, contain_unexamined,
                hashlib.sha256((auth_key or "").encode()).digest())
    with _preview_index_lock:
        key = (_preview_index_epoch, identity, signature)
        cached = _preview_indices.get(identity)
        if cached and cached[0] == signature and cached[1] > time.monotonic():
            _preview_indices.move_to_end(identity)
            return cached[2]
        pending = _preview_index_pending.get(key)
        owner = pending is None
        if owner:
            pending = Future()
            _preview_index_pending[key] = pending
    if not owner:
        return await asyncio.shield(asyncio.wrap_future(pending))
    try:
        raw = await client.getAllRankingInfo(
            rank, index, contain_unexamined, 1, min(int(stat.count) + 1, 2147483647)
        ) if stat.count else []
        # RPC cannot limit its index response. Bound retained memory and never truncate silently.
        if len(raw) > PREVIEW_INDEX_LIMIT:
            raise ValueError("榜单索引超过当前预览容量，请联系维护者调整；未截断稿件。")
        seen = set()
        detached = []
        for item in raw:
            if item.bvid not in seen:
                seen.add(item.bvid)
                detached.append((str(item.avid), str(item.bvid)))
        snapshot = tuple(detached)
        with _preview_index_lock:
            if key[0] == _preview_index_epoch:
                _preview_indices.pop(identity, None)
                while _preview_indices and (len(_preview_indices) >= 8 or
                        sum(len(entry[2]) for entry in _preview_indices.values()) + len(snapshot) > PREVIEW_INDEX_LIMIT):
                    _preview_indices.popitem(last=False)
                _preview_indices[identity] = (signature, time.monotonic() + PREVIEW_INDEX_TTL, snapshot)
            pending.set_result(snapshot)
        return snapshot
    except BaseException as error:
        pending.set_exception(error)
        raise
    finally:
        with _preview_index_lock:
            _preview_index_pending.pop(key, None)


def format_video_entry(entry):
    """Format video data for frontend"""
    "这里的逻辑一定要重写"

    def Rank2str(rank: Rank):
        match rank:
            case Rank.DOMESTIC:
                return "domestic"
            case Rank.SV:
                return "sv"
            case Rank.UTAU:
                return "utau"
            case _:
                return "unknown"

    ranks = list(map(capnp_to_Rank, entry.ranks))
    ranks = list(map(Rank2str, ranks))
    pub_time = datetime.fromtimestamp(
        entry.pubdate.seconds + entry.pubdate.nanoseconds / 1_000_000_000
    )

    return {
        "avid": entry.avid,
        "bvid": entry.bvid,
        "title": entry.title,
        "uploader": entry.uploader,
        "up_face": entry.upFace,
        "cover": entry.cover,
        "pubdate": pub_time.strftime("%Y-%m-%d %H:%M:%S"),
        "pub_timestamp": entry.pubdate.seconds,
        "duration": entry.duration,
        "tags": list(entry.tags),
        "desc": entry.desc,
        "ranks": ranks,
        "is_examined": entry.isExamined,
        "is_republish": entry.isRepublish,
        "staff_info": entry.staffInfo,
    }


async def get_videos_async(
    keyword: str | None,
    rank_filter: str | None,
    examined: str,
    bvid: str | None,
    avid: str | None,
    page: int,
    page_size: int,
    date_str: str | None = None,
    auth_key: str | None = None,
    is_republish: str = "",
):
    """Get videos from CVSE server"""
    now = datetime.now()

    if date_str:
        selected_date = datetime.strptime(date_str, "%Y-%m-%d")
        start_week = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_week = start_week + timedelta(days=1)
    else:
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        start_week = today
        end_week = today + timedelta(days=1)

    client = await CVSE_Client.create(CVSE_HOST, CVSE_PORT, auth_key)

    get_unexamined = examined in {"unexamined", "", "false", "no", "other"}
    get_unincluded = True

    indices = await client.getAll(
        get_unexamined,
        get_unincluded,
        RPCTime.from_datetime(start_week),
        RPCTime.from_datetime(end_week),
    )

    if not indices:
        return {
            "data": [],
            "total": 0,
            "stats": {
                "total": 0,
                "domestic": 0,
                "sv": 0,
                "utau": 0,
                "republish": 0,
                "uncheck": 0,
                "exclusion": 0,
                "other": 0,
            },
            "date_range": {
                "date": start_week.strftime("%Y年%m月%d日"),
            },
        }

    videos = await client.lookupMetaInfo(list(indices))
    formatted_videos = [format_video_entry(video) for video in videos]

    filtered = formatted_videos

    if keyword:
        normalized_keyword = keyword.lower()
        filtered = [
            v
            for v in filtered
            if normalized_keyword in v["title"].lower()
            or normalized_keyword in v["uploader"].lower()
            or normalized_keyword in v["desc"].lower()
            or any(normalized_keyword in tag.lower() for tag in v["tags"])
        ]

    if bvid:
        filtered = [v for v in filtered if bvid.lower() in v["bvid"].lower()]

    if avid:
        filtered = [v for v in filtered if avid.lower() in v["avid"].lower()]

    if rank_filter and rank_filter != "all":
        if rank_filter == "unrecorded":
            filtered = [v for v in filtered if len(v["ranks"]) == 0]
        else:
            selected_ranks = set(rank_filter.split(","))
            filtered = [v for v in filtered if selected_ranks.intersection(v["ranks"])
                        or ("other" in selected_ranks and not v["is_examined"] and not v["ranks"])]

    if examined in {"yes", "true"}:
        filtered = [v for v in filtered if v["is_examined"] and len(v["ranks"]) > 0]
    elif examined in {"no", "false"}:
        filtered = [v for v in filtered if not v["is_examined"]]
    elif examined == "exclusion":
        filtered = [v for v in filtered if v["is_examined"] and len(v["ranks"]) == 0]
    elif examined == "other":
        filtered = [v for v in filtered if not v["is_examined"] and not v["ranks"]]

    if is_republish in {"true", "false"}:
        republish = is_republish == "true"
        filtered = [v for v in filtered if v["is_republish"] == republish]

    total = len(filtered)
    start = (page - 1) * page_size
    end = start + page_size
    paginated = filtered[start:end]

    stats = {
        "total": len(filtered),
        "domestic": len([v for v in filtered if "domestic" in v["ranks"]]),
        "sv": len([v for v in filtered if "sv" in v["ranks"]]),
        "utau": len([v for v in filtered if "utau" in v["ranks"]]),
        "republish": len([v for v in filtered if v["is_republish"]]),
        "uncheck": len([v for v in filtered if not v["is_examined"]]),
        "exclusion": len([v for v in filtered if v["is_examined"] and len(v["ranks"]) == 0]),
        "other": sum(not v["is_examined"] and not v["ranks"] for v in filtered),
    }

    return {
        "data": paginated,
        "total": total,
        "stats": stats,
        "date_range": {
            "date": start_week.strftime("%Y年%m月%d日"),
        },
    }


async def get_video_async(bvid: str, auth_key: str | None = None):
    """Get single video by bvid"""
    client = await CVSE_Client.create(CVSE_HOST, CVSE_PORT, auth_key)

    indices = [Index_to_capnp(bv_to_index(bvid))]
    videos = await client.lookupMetaInfo(indices)

    if not videos:
        return None

    return format_video_entry(videos[0])


async def submit_changes_async(changes: list[dict], auth_key: str | None = None):
    """Submit batch changes to CVSE server"""
    client = await CVSE_Client.create(CVSE_HOST, CVSE_PORT, auth_key)

    modify_entries = []
    for change in changes:
        ranks_input = change.get("ranks")
        ranks_list = []
        for r in ranks_input:
            if isinstance(r, int):
                r = str(r)
            if isinstance(r, str):
                ranks_list.append(Rank[r.upper()])
        ranks = ranks_list

        assert "avid" in change, "Each change must include 'avid'"
        assert "bvid" in change, "Each change must include 'bvid'"

        entry: ModifyEntry = {
            "avid": change["avid"],
            "bvid": change["bvid"],
            "ranks": ranks,
            "is_republish": change.get("is_republish"),
            "staff": change.get("staff_info"),
            "is_examined": change.get("is_examined"),
        }
        modify_entries.append(ModifyEntry_to_capnp(entry))

    await client.updateModifyEntry(modify_entries)
    return len(changes)


async def reCalculate_rankings_async(
    rank_name: str,
    index: int,
    contain_unexamined: bool,
    lock: bool,
    auth_key: str | None = None,
):
    """recalculate rankings"""
    rank = Rank[rank_name.upper()]
    client = await CVSE_Client.create(CVSE_HOST, CVSE_PORT, auth_key)
    invalidate_preview_indices()
    try:
        await client.reCalculateRankings(rank, index, contain_unexamined, lock)
    finally:
        invalidate_preview_indices()
    return f"Recalculated rankings for {rank_name}"


async def check_if_calculated(
    rank_name: str, index: int, contain_unexamined: bool, auth_key: str | None = None
):
    """check if rankings are calculated"""
    rank = Rank[rank_name.upper()]
    client = await CVSE_Client.create(CVSE_HOST, CVSE_PORT, auth_key)
    try:
        await client.lookupRankingMetaInfo(rank, index, contain_unexamined)
        return True
    except Exception:
        return False


@app.route("/")
def index():
    """Return frontend page"""
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.route("/api/health")
@limiter.limit("120 per minute")
def health():
    """API: Health check"""
    return jsonify(
        {
            "status": "healthy",
            "server": "CVSE Backend",
            "time": datetime.now().isoformat(),
        }
    )


def get_auth_key_from_request():
    """Get auth key from request header or args"""
    auth_key = request.headers.get("X-Auth-Key") or request.args.get("auth_key")
    if auth_key:
        return auth_key
    return None


@app.route("/api/auth/validate", methods=["POST"])
@limiter.limit("30 per minute")
def validate_auth():
    """API: Validate auth key by testing a simple CVSE connection"""
    try:
        data = request.get_json()
        auth_key = data.get("auth_key")

        if not auth_key:
            return jsonify({"success": False, "error": "No auth key provided"}), 400

        async def test_auth():
            client = await CVSE_Client.create(CVSE_HOST, CVSE_PORT, auth_key)
            try:
                await client.lookupRankingMetaInfo(Rank.UTAU, 1, True)
                return True
            except Exception:
                return False

        is_valid = asyncio.run(capnp.run(test_auth()))

        if is_valid:
            return jsonify(
                {"success": True, "valid": True, "message": "Auth key is valid"}
            )
        else:
            return jsonify(
                {"success": True, "valid": False, "message": "Auth key may be invalid"}
            )
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/videos", methods=["GET"])
@limiter.limit("30 per minute")
def get_videos():
    """API: Get videos with filters"""
    try:
        keyword = request.args.get("keyword", "")
        rank_filter = request.args.get("rank", "all")
        examined = request.args.get("examined", "")
        bvid = request.args.get("bvid", "")
        avid = request.args.get("avid", "")
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("page_size", 100))
        date_str = request.args.get("date", "")
        auth_key = get_auth_key_from_request()
        is_republish = request.args.get("is_republish", "").strip().lower()
        if is_republish not in {"", "true", "false"}:
            return jsonify(
                {"success": False, "error": "is_republish must be true, false, or empty"}
            ), 400

        result = asyncio.run(
            capnp.run(
                get_videos_async(
                    keyword,
                    rank_filter,
                    examined,
                    bvid,
                    avid,
                    page,
                    page_size,
                    date_str,
                    auth_key,
                    is_republish,
                )
            )
        )

        return jsonify(
            {
                "success": True,
                "data": result.get("data", []),
                "total": result.get("total", 0),
                "stats": result.get("stats", {}),
                "page": page,
                "page_size": page_size,
                "date_range": result.get("date_range", {}),
            }
        )
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/video/<bvid>", methods=["GET"])
@limiter.limit("120 per minute")
def get_video(bvid):
    """API: Get single video by bvid"""
    try:
        auth_key = get_auth_key_from_request()
        video = asyncio.run(capnp.run(get_video_async(bvid, auth_key)))

        if not video:
            return jsonify({"success": False, "error": "Video not found"}), 404

        return jsonify({"success": True, "data": video})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/submit-changes", methods=["POST"])
@limiter.limit("10 per minute")
def submit_changes():
    """API: Submit batch changes to CVSE server"""
    try:
        data = request.get_json()
        changes = data.get("changes", [])
        auth_key = get_auth_key_from_request()

        if not changes:
            return jsonify({"success": False, "error": "No changes to submit"})

        count = asyncio.run(capnp.run(submit_changes_async(changes, auth_key)))

        return jsonify({"success": True, "message": f"Submitted {count} changes"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/calculate-rankings", methods=["POST"])
# @limiter.limit("1 per minute")
def calculate_rankings():
    """
    API: Calculate rankings for a specific rank
    Costly operation, should be used with caution.
    """
    try:
        data = request.get_json()
        rank_name = data.get("rank", "domestic")
        index = int(data.get("index", 0))
        contain_unexamined = data.get("contain_unexamined", True)
        lock = data.get("lock", False)
        auth_key = get_auth_key_from_request()

        message = asyncio.run(
            capnp.run(
                reCalculate_rankings_async(
                    rank_name, index, contain_unexamined, lock, auth_key
                )
            )
        )

        return jsonify({"success": True, "message": message})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def parse_video_index(value):
    """Validate a complete ID before any RPC; never scan rankings to resolve it."""
    value = value.strip()
    if re.fullmatch(r"(?:av)?[1-9][0-9]{0,15}", value, re.IGNORECASE):
        number = int(re.sub(r"^av", "", value, flags=re.IGNORECASE))
        if number >= 1 << 51:
            raise ValueError("AV号超出有效范围")
        return av_to_index(f"av{number}")
    if value[:2].lower() == "bv" and re.fullmatch(r"BV1[1-9A-HJ-NP-Za-km-z]{9}", "BV" + value[2:]):
        return bv_to_index("BV" + value[2:])
    raise ValueError("请输入完整的 BV号或 AV号（也可输入纯数字 AV号）")


async def get_ranking_preview_async(
    rank_name: str,
    index: int,
    contain_unexamined: bool,
    auth_key: str | None = None,
    page: int = 1,
    page_size: int = 20,
    show_special: bool = False,
    include_special: bool = False,
    video_id: str = "",
):
    """Page by cached ordered IDs, fetching details only for the requested rows."""
    if page < 1 or not 1 <= page_size <= 110:
        raise ValueError("page must be >= 1 and page_size must be between 1 and 110")
    search_index = parse_video_index(video_id) if video_id else None
    client = await CVSE_Client.create(CVSE_HOST, CVSE_PORT, auth_key)
    rank = Rank[rank_name.upper()]
    empty_result = {
        "stat": {
            "count": 0,
            "totalView": 0,
            "totalLike": 0,
            "totalCoin": 0,
            "totalFavorite": 0,
            "totalNew": 0,
        },
        "entries": [],
        "page": page,
        "page_size": page_size,
        "total": 0,
        "search_id": video_id,
    }
    # A failed RPC is not an empty ranking. Propagate it to the API error handler.
    stat = await client.lookupRankingMetaInfo(rank, index, contain_unexamined)

    if stat.count == 0 and not include_special and not search_index:
        return empty_result

    # Rank is not an offset: competition ties leave gaps (989 x54 -> 1043).
    # The RPC returns rank-ordered indexes; reuse their row positions across pages.
    start = (page - 1) * page_size
    indices = []
    total = stat.count
    if search_index:
        indices = [Index_to_capnp(search_index)]
    else:
        snapshot = await get_preview_indices(client, rank, index, contain_unexamined, auth_key, stat)
        total = len(snapshot)
        indices = [Index_to_capnp({"avid": avid, "bvid": bvid})
                   for avid, bvid in snapshot[start:start + page_size]]
    entries = list(await client.lookupRankingInfo(
        rank, index, contain_unexamined, indices
    ))[:1 if search_index else page_size] if indices else []
    # Detail RPC order is unspecified, including among ties. Keep snapshot order.
    entry_map = {entry.bvid: entry for entry in entries}
    entries = [entry_map[item.bvid] for item in indices if item.bvid in entry_map]
    meta_infos = await client.lookupMetaInfo(indices) if entries else []

    normal_count = len(entries)
    special_truncated = False
    if include_special and not search_index:
        # The schema specifies [from_rank, to_rank), so [0, 1) is rank zero only.
        # It has no upstream limit field; bound subsequent detail/metadata work.
        zero_indices = await client.getAllRankingInfo(rank, index, contain_unexamined, 0, 1)
        special_truncated = len(zero_indices) > 100
        selected = [zero_indices[i] for i in range(min(len(zero_indices), 100))]
        if selected:
            zero_entries = await client.lookupRankingInfo(rank, index, contain_unexamined, selected)
            special_entries = [zero_entries[i] for i in range(min(len(zero_entries), 100))]
            special_entries = [entry for entry in special_entries
                               if entry.rank == 0 and str(entry.specialRank).lower() in {'hot', 'sh'}]
            if special_entries:
                special_bvids = {entry.bvid for entry in special_entries}
                selected = [item for item in selected if item.bvid in special_bvids]
                special_meta = await client.lookupMetaInfo(selected)
                meta_infos = list(meta_infos) + list(special_meta)
                entries.extend(special_entries)

    video_info_map = {}
    for meta_info in meta_infos:
        bvid = meta_info.bvid
        video_info_map[bvid] = {
            "title": meta_info.title,
            "uploader": meta_info.uploader,
            "cover": meta_info.cover,
            "desc": meta_info.desc,
            "duration": meta_info.duration,
            "ranks": format_video_entry(meta_info)["ranks"],
            "is_examined": meta_info.isExamined,
        }
    formatted_entries = []
    for entry in entries:
        video_info = video_info_map.get(entry.bvid, {})
        formatted_entries.append(
            {
                "rank": entry.rank,
                "bvid": entry.bvid,
                "avid": entry.avid,
                "title": video_info.get("title", ""),
                "uploader": video_info.get("uploader", ""),
                "cover": video_info.get("cover", ""),
                "duration": video_info.get("duration"),
                "ranks": video_info.get("ranks", []),
                "is_examined": video_info.get("is_examined", False),
                "view": entry.view,
                "like": entry.like,
                "coin": entry.coin,
                "favorite": entry.favorite,
                "share": entry.share,
                "reply": entry.reply,
                "danmaku": entry.danmaku,
                "specialRank": str(entry.specialRank).lower(),
                "special_rank": str(entry.specialRank).lower(),
                "totalScore": entry.totalScore,
                "isNew": entry.isNew,
            }
        )

    return {
        # Summary count includes rank-zero specials; pagination counts indexed rows only.
        "stat": {
            "count": stat.count,
            "totalView": stat.totalView,
            "totalLike": stat.totalLike,
            "totalCoin": stat.totalCoin,
            "totalFavorite": stat.totalFavorite,
            "totalNew": stat.totalNew,
        },
        "entries": formatted_entries[:normal_count],
        "special_entries": formatted_entries[normal_count:],
        "special_truncated": special_truncated,
        "page": page,
        "page_size": page_size,
        "total": total,
        "search_id": video_id,
    }


@app.route("/api/ranking-preview", methods=["GET"])
@limiter.limit("30 per minute")
def get_ranking_preview():
    """API: Get ranking preview data with pagination"""
    try:
        rank_name = request.args.get("rank", "domestic")
        try:
            index = int(request.args.get("index", 1))
        except ValueError:
            return jsonify(success=False, error="期数必须为正整数"), 400
        contain_unexamined = (
            request.args.get("contain_unexamined", "true").lower() == "true"
        )
        try:
            page = int(request.args.get("page", 1))
            page_size = int(request.args.get("page_size", 20))
        except (TypeError, ValueError):
            return jsonify(success=False, error="page and page_size must be integers"), 400
        if page < 1 or not 1 <= page_size <= 110:
            return jsonify(success=False, error="page must be >= 1 and page_size must be between 1 and 110"), 400
        video_id = request.args.get("video_id", "").strip()
        try:
            if rank_name not in {"domestic", "sv", "utau"} or not 1 <= index <= 2147483647:
                raise ValueError("请选择有效的期刊和期数")
            if video_id:
                parse_video_index(video_id)
        except ValueError as error:
            return jsonify(success=False, error=str(error)), 400
        show_special = request.args.get("show_special", "false").lower() == "true"
        include_special = request.args.get("include_special", "false").lower() == "true"
        auth_key = get_auth_key_from_request()

        result = asyncio.run(
            capnp.run(
                get_ranking_preview_async(
                    rank_name,
                    index,
                    contain_unexamined,
                    auth_key,
                    page,
                    page_size,
                    show_special,
                    include_special,
                    video_id,
                )
            )
        )

        return jsonify({"success": True, "data": result})
    except Exception as e:
        # This explicit upstream response means there is no cached ranking.
        # Keep it distinct from an empty calculated ranking and connectivity failures.
        if "No ranking meta info found" in str(e):
            return jsonify(success=False, code="ranking_unavailable",
                           error="该期暂无可读取的已计算榜单，请核对期刊和期数，或稍后再来查看。"), 404
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/debug", methods=["GET", "POST"])
@limiter.limit("20 per minute")
def api_debug():
    """API: Debug endpoint to test raw CVSE API calls"""
    try:
        if request.method == "GET":
            return jsonify(
                {
                    "success": True,
                    "available_endpoints": [
                        "/api/videos - Get videos with filters",
                        "/api/video/<bvid> - Get single video",
                        "/api/submit-changes - Submit batch changes",
                        "/api/calculate-rankings - Calculate rankings",
                        "/api/debug - This debug endpoint",
                    ],
                    "filters": {
                        "keyword": "Search in title/uploader",
                        "rank": "domestic/sv/utau/unrecorded/all",
                        "examined": "yes/no/unexamined",
                        "is_republish": "true/false/empty (all)",
                        "bvid": "Filter by BV id",
                        "avid": "Filter by AV id",
                    },
                }
            )

        return jsonify({"success": True, "message": "Debug endpoint working"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def main():
    host = os.getenv("CVSE_SERVER_HOST", "0.0.0.0")
    port = int(os.getenv("CVSE_SERVER_PORT", "25123"))
    print("Starting CVSE server (Enhanced Version)...")
    print(f"Visit: http://{host}:{port}")
    serve(app, host=host, port=port)


if __name__ == "__main__":
    main()
