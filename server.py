#!/usr/bin/env python3
"""
CVSE Web Server - Enhanced Version
Supports recording, preview, API debugging, offline changes

Copyright (c) 2026 milkboy, yhtq
"""

import asyncio
import logging
import os
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
    capnp_to_Rank,
)

app = Flask(__name__)
CORS(app)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["100 per minute"],
)

CVSE_HOST = "47.104.152.246"
CVSE_PORT = "8663"


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

    get_unexamined = examined in {"unexamined", "", "false", "no"}
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

    if rank_filter != "all":
        if rank_filter == "unrecorded":
            filtered = [v for v in filtered if len(v["ranks"]) == 0]
        else:
            filtered = [v for v in filtered if rank_filter in v["ranks"]]

    if examined in {"yes", "true"}:
        filtered = [v for v in filtered if v["is_examined"] and len(v["ranks"]) > 0]
    elif examined in {"no", "false"}:
        filtered = [v for v in filtered if not v["is_examined"]]
    elif examined == "exclusion":
        filtered = [v for v in filtered if v["is_examined"] and len(v["ranks"]) == 0]

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
    await client.reCalculateRankings(rank, index, contain_unexamined, lock)
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


async def get_ranking_preview_async(
    rank_name: str,
    index: int,
    contain_unexamined: bool,
    auth_key: str | None = None,
    page: int = 1,
    page_size: int = 20,
    show_special: bool = False,
    include_special: bool = False,
):
    """Read only one bounded upstream rank interval; display filtering is local."""
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("page must be >= 1 and page_size must be between 1 and 100")
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
    }
    try:
        stat = await client.lookupRankingMetaInfo(rank, index, contain_unexamined)
    except Exception as e:
        logging.warning(f"Error looking up ranking meta info: {e}")
        return empty_result

    if stat.count == 0 and not include_special:
        return empty_result

    # Normal pages retain their bounded rank interval; never scan the whole ranking.
    from_rank = (page - 1) * page_size + 1
    to_rank = min(from_rank + page_size, stat.count + 1)
    indices = []
    if from_rank < to_rank:
        page_indices = await client.getAllRankingInfo(
            rank, index, contain_unexamined, from_rank, to_rank
        )
        indices = [page_indices[i] for i in range(min(len(page_indices), page_size))]
    entries = list(await client.lookupRankingInfo(
        rank, index, contain_unexamined, indices
    ))[:page_size] if indices else []
    entries.sort(key=lambda entry: entry.rank)
    meta_infos = await client.lookupMetaInfo(indices) if entries else []

    normal_count = len(entries)
    special_truncated = False
    if include_special:
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
        # Counts describe the original upstream ranking, not locally visible rows.
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
        "total": stat.count,
    }


@app.route("/api/ranking-preview", methods=["GET"])
@limiter.limit("30 per minute")
def get_ranking_preview():
    """API: Get ranking preview data with pagination"""
    try:
        rank_name = request.args.get("rank", "domestic")
        index = int(request.args.get("index", 0))
        contain_unexamined = (
            request.args.get("contain_unexamined", "true").lower() == "true"
        )
        try:
            page = int(request.args.get("page", 1))
            page_size = int(request.args.get("page_size", 20))
        except (TypeError, ValueError):
            return jsonify(success=False, error="page and page_size must be integers"), 400
        if page < 1 or not 1 <= page_size <= 100:
            return jsonify(success=False, error="page must be >= 1 and page_size must be between 1 and 100"), 400
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
                )
            )
        )

        return jsonify({"success": True, "data": result})
    except Exception as e:
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
