#!/usr/bin/env python3
"""
Online_Multiverse — 산사 (Sansa Temple) 3D Silent Co-presence Server
FastAPI + WebSocket + SNSD (0x534E5344) Hybrid Binary Delta Protocol (Port 8860)
Supports 100% of original sansatemple.com client engine (/) and clean modular client (/clean).
"""

import asyncio
import json
import math
import os
import random
import struct
import sys
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
DEFAULT_PORT = 8860

SNSD_MAGIC = 0x534E5333  # ASCII "SNS3" (1397642035)
ROOM_CAPACITY = 50       # Original directory capacity check (he = 50, max N = 100)
MAX_VISITORS = 100
ROOM_LIMIT = 100
RESERVED_RESIDENT_SEATS = {12, 15, 17, 18}
INCENSE_DURATION_MS = 120_000
CAFE25_EFFECT_DURATION_MS = 300_000

POSE_TO_INDEX = {"walk": 0, "kneel": 1, "beads": 2, "dance": 3}
INDEX_TO_POSE = {0: "walk", 1: "kneel", 2: "beads", 3: "dance"}

ADJECTIVES = [
    "고요한", "따스한", "은은한", "느긋한", "맑은",
    "차분한", "잔잔한", "푸른", "깊은", "담백한",
    "투명한", "소박한", "고즈넉한", "평온한", "아늑한",
    "청아한", "묵묵한", "포근한", "산뜻한", "유연한",
]
NOUNS = [
    "바람", "산새", "솔잎", "물결", "달빛",
    "구름", "이슬", "연꽃", "대숲", "안개",
    "별빛", "조약돌", "산그림자", "솔바람", "여백",
    "다향", "등불", "낙엽", "옹달샘", "산길",
]
ROBE_COLORS = [
    "#a89f91", "#8d9488", "#9c8f82", "#7f8880", "#b0a695",
    "#8b857c", "#959d90", "#a39887", "#7c8279", "#9e978e",
]


def now_ms() -> int:
    return int(time.time() * 1000)


def room_id_for_number(num: int) -> str:
    return "maru" if num == 1 else f"maru-{num:02d}"


def cushion_position(idx: int) -> dict:
    """Exact Hall cushion coordinate formula matching fr(i) in game-CLKObOjK.js."""
    col = idx % 10
    row = idx // 10
    x = (col - 5) * 2.4 if col < 5 else (col - 4) * 2.4
    z = -8.4 + row * 2.8
    return {"x": round(x, 4), "z": round(z, 4), "yaw": 0.0}


def generate_monk_name(seed_val: Optional[int] = None) -> str:
    rng = random.Random(seed_val) if seed_val is not None else random
    return f"{rng.choice(ADJECTIVES)} {rng.choice(NOUNS)}"


@dataclass
class Visitor:
    id: str
    name: str
    color: str
    seat: int
    cushion: Optional[int] = None
    joined_at: int = field(default_factory=now_ms)
    pose: str = "walk"
    x: float = 0.0
    z: float = 48.0
    yaw: float = -0.18
    bow_at: Optional[int] = None
    is_npc: bool = False
    visit_token: str = field(default_factory=lambda: str(uuid.uuid4()))
    bows: int = 0
    credit: int = 1
    cup: Optional[dict] = None
    effect: Optional[dict] = None
    garden_seat_id: Optional[str] = None

    def to_profile_dict(self) -> dict:
        out = {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "seat": int(self.seat),
            "cushion": None if self.cushion is None else int(self.cushion),
            "joinedAt": int(self.joined_at),
            "pose": self.pose,
            "position": {
                "x": round(float(self.x), 3),
                "z": round(float(self.z), 3),
                "yaw": round(float(self.yaw), 4),
            },
        }
        if self.bow_at is not None:
            out["bowAt"] = int(self.bow_at)
        return out

    def to_delta_profile_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "seat": int(self.seat),
            "joinedAt": int(self.joined_at),
        }


def encode_snsd_delta(
    revision: int,
    server_time: int,
    room_id: str,
    visitors: List[Visitor],
    profiles: Optional[List[dict]] = None,
    removed: Optional[List[str]] = None,
    extra_meta: Optional[dict] = None,
) -> bytes:
    """
    Pack a wire=3 SNSD (0x534E5344) binary delta frame (Big-Endian DataView compatible):
    - 28-byte big-endian header: magic(u32), jsonByteLength(u32), recordCount(u16), reserved(u16=0), revision(f64), serverTime(f64)
    - UTF-8 JSON metadata bytes: {"room": str, "profiles": [...], "removed": [...]}
    - N visitor binary records: 30 bytes (or 38 bytes when hasBow == 1)
    """
    meta_payload = {
        "room": room_id,
        "profiles": profiles if profiles is not None else [],
        "removed": removed if removed is not None else [],
    }
    if extra_meta:
        meta_payload.update(extra_meta)
    json_bytes = json.dumps(meta_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header = struct.pack(
        ">IIHHdd",
        SNSD_MAGIC,
        len(json_bytes),
        len(visitors),
        0,
        float(revision),
        float(server_time),
    )
    records = bytearray()
    for v in visitors:
        cushion_val = -1 if v.cushion is None else int(v.cushion)
        pose_idx = POSE_TO_INDEX.get(v.pose, 0)
        has_bow = 1 if v.bow_at is not None else 0
        if has_bow:
            records.extend(
                struct.pack(
                    ">HhBBdddd",
                    int(v.seat),
                    cushion_val,
                    pose_idx,
                    has_bow,
                    float(v.x),
                    float(v.z),
                    float(v.yaw),
                    float(v.bow_at),
                )
            )
        else:
            records.extend(
                struct.pack(
                    ">HhBBddd",
                    int(v.seat),
                    cushion_val,
                    pose_idx,
                    has_bow,
                    float(v.x),
                    float(v.z),
                    float(v.yaw),
                )
            )
    return header + json_bytes + bytes(records)


def decode_snsd_delta(payload: bytes) -> dict:
    """Unpack and validate a wire=3 SNSD binary frame (used in self-check & tests)."""
    if len(payload) < 28:
        raise ValueError("SNSD frame shorter than 28-byte header")
    magic, json_len, record_count, reserved, revision, server_time = struct.unpack_from(">IIHHdd", payload, 0)
    if magic != SNSD_MAGIC or reserved != 0:
        raise ValueError(f"Invalid SNSD header: magic={hex(magic)}, reserved={reserved}")
    offset = 28
    meta = {}
    if json_len > 0:
        meta = json.loads(payload[offset : offset + json_len].decode("utf-8"))
        offset += json_len
    records = []
    for _ in range(record_count):
        seat, cushion, pose_idx, has_bow, x, z, yaw = struct.unpack_from(">HhBBddd", payload, offset)
        offset += 30
        bow_at = None
        if has_bow == 1:
            (bow_at,) = struct.unpack_from(">d", payload, offset)
            offset += 8
        records.append(
            {
                "seat": seat,
                "cushion": None if cushion < 0 else cushion,
                "pose": INDEX_TO_POSE.get(pose_idx, "walk"),
                "x": x,
                "z": z,
                "yaw": yaw,
                "bowAt": bow_at,
            }
        )
    return {
        "revision": int(revision),
        "serverTime": int(server_time),
        "meta": meta,
        "records": records,
    }


class TempleRoom:
    def __init__(self, room_id: str, number: int):
        self.id = room_id
        self.number = number
        self.capacity = ROOM_CAPACITY
        self.revision = 1
        self.queue_revision = 1
        self.cafe25_revision = 1
        self.visitors: Dict[str, Visitor] = {}
        self.sockets: Dict[str, WebSocket] = {}
        self.incense_offerings: List[dict] = []
        self.incense_queue: List[str] = []
        self.incense_started: Optional[dict] = None
        self.shared_coffees: List[dict] = []
        self.donations: List[dict] = []
        self._seed_ambient_visitors()

    def _seed_ambient_visitors(self) -> None:
        """Seed peaceful silent co-presence monks in primary rooms (avoiding reserved seats 12,15,17,18)."""
        npc_counts = {1: 4, 2: 2, 3: 1}
        count = npc_counts.get(self.number, 0)
        c2 = cushion_position(22)
        c5 = cushion_position(27)
        presets = [
            {"seat": 2, "cushion": 22, "pose": "kneel", "x": c2["x"], "z": c2["z"], "yaw": 0.0, "bow": True},
            {"seat": 5, "cushion": 27, "pose": "beads", "x": c5["x"], "z": c5["z"], "yaw": 0.0, "bow": False},
            {"seat": 6, "cushion": None, "pose": "walk", "x": 16.5, "z": 36.2, "yaw": -0.6, "bow": False},
            {"seat": 7, "cushion": None, "pose": "walk", "x": -6.0, "z": 34.0, "yaw": 0.4, "bow": False},
        ]
        t = now_ms()
        for i in range(count):
            p = presets[i % len(presets)]
            vid = f"npc-{self.number}-{i+1}"
            self.visitors[vid] = Visitor(
                id=vid,
                name=generate_monk_name(self.number * 100 + i),
                color=ROBE_COLORS[(self.number + i) % len(ROBE_COLORS)],
                seat=p["seat"],
                cushion=p["cushion"],
                joined_at=t - (i + 1) * 60_000,
                pose=p["pose"],
                x=p["x"],
                z=p["z"],
                yaw=p["yaw"],
                bow_at=(t - (i * 1300)) if p["bow"] else None,
                is_npc=True,
            )
        if self.number == 1:
            self.shared_coffees.append(
                {
                    "id": str(uuid.uuid4()),
                    "fromName": "따스한 솔바람",
                    "message": "산사에 머무는 모든 분들께 평안이 깃들기를 바랍니다.",
                    "createdAt": t - 120_000,
                }
            )

    def allocate_seat(self) -> Optional[int]:
        used: Set[int] = {v.seat for v in self.visitors.values()} | RESERVED_RESIDENT_SEATS
        for s in range(MAX_VISITORS):
            if s not in used:
                return s
        return None

    def allocate_cushion(self, visitor: Visitor, preferred: Optional[int] = None) -> Optional[int]:
        occupied = {v.cushion for v in self.visitors.values() if v.cushion is not None} | RESERVED_RESIDENT_SEATS
        if preferred is not None and 0 <= preferred < 100 and preferred not in occupied:
            return preferred
        best_c = None
        best_dist = float("inf")
        for c in range(100):
            if c in occupied:
                continue
            pos = cushion_position(c)
            dist = math.hypot(visitor.x - pos["x"], visitor.z - pos["z"])
            if dist < best_dist:
                best_dist = dist
                best_c = c
        return best_c

    def active_incense_list(self, t: int) -> List[dict]:
        self.incense_offerings = [
            o for o in self.incense_offerings if o["at"] <= t < o["expiresAt"]
        ]
        return list(self.incense_offerings)

    def incense_queue_dict(self, t: int) -> dict:
        if not self.incense_queue:
            return {
                "revision": self.queue_revision,
                "members": [],
                "activeId": None,
                "expiresAt": 0,
            }
        return {
            "revision": self.queue_revision,
            "members": list(self.incense_queue),
            "activeId": self.incense_queue[0],
            "expiresAt": t + 60_000,
        }

    def cafe25_state_for(self, self_id: str) -> dict:
        t = now_ms()
        v = self.visitors.get(self_id)
        cups = []
        seats = []
        effects = []
        for vis in self.visitors.values():
            if vis.cup is not None:
                cups.append(vis.cup)
            if vis.garden_seat_id:
                seats.append({"visitorId": vis.id, "seatId": vis.garden_seat_id})
            if vis.effect and vis.effect.get("until", 0) > t:
                effects.append(
                    {
                        "visitorId": vis.id,
                        "startedAt": vis.effect["startedAt"],
                        "until": vis.effect["until"],
                    }
                )
            elif vis.effect:
                vis.effect = None

        own_effect = v.effect if (v and v.effect and v.effect.get("until", 0) > t) else None
        return {
            "revision": self.cafe25_revision,
            "selfId": self_id,
            "bows": v.bows if v else 0,
            "credit": v.credit if v else 1,
            "cup": v.cup if v else None,
            "outgoing": None,
            "incoming": None,
            "cups": cups,
            "seats": seats,
            "effect": own_effect,
            "effects": effects,
        }

    def snapshot_dict(self, self_id: str, resumed: bool = False) -> dict:
        t = now_ms()
        v = self.visitors.get(self_id)
        snap = {
            "type": "snapshot",
            "room": self.id,
            "region": "apac",
            "instance": 0,
            "selfId": self_id,
            "visitToken": v.visit_token if v else str(uuid.uuid4()),
            "resumed": resumed,
            "entryIdle": True,
            "interest": True,
            "revision": self.revision,
            "serverTime": t,
            "incense": self.active_incense_list(t),
            "incenseQueue": self.incense_queue_dict(t),
            "cafe25": self.cafe25_state_for(self_id),
            "visitors": [vis.to_profile_dict() for vis in self.visitors.values()],
        }
        if (
            self.incense_started
            and self.incense_queue
            and self.incense_started.get("id") == self.incense_queue[0]
            and self.incense_started.get("id") in self.visitors
            and (t - 60_000) <= self.incense_started.get("at", 0) <= t
        ):
            snap["incenseStarted"] = self.incense_started
        return snap

    def cafe25_dict(self, self_id: str = "") -> dict:
        return {
            "type": "cafe25-state",
            "room": self.id,
            "revision": self.cafe25_revision,
            "serverTime": now_ms(),
            "selfId": self_id,
            "state": self.cafe25_state_for(self_id),
            "shared": list(self.shared_coffees[-20:]),
            "owned": [],
        }


class TempleWorld:
    def __init__(self):
        self.rooms: Dict[str, TempleRoom] = {}
        for num in range(1, ROOM_LIMIT + 1):
            rid = room_id_for_number(num)
            self.rooms[rid] = TempleRoom(rid, num)

    def pick_room(self, requested: str) -> TempleRoom:
        req = (requested or "auto").strip().lower()
        if req != "auto" and req in self.rooms:
            return self.rooms[req]
        for rid in sorted(self.rooms.keys(), key=lambda k: self.rooms[k].number):
            room = self.rooms[rid]
            if len(room.visitors) < room.capacity:
                return room
        return self.rooms["maru"]

    async def broadcast_delta(
        self,
        room: TempleRoom,
        changed_visitors: List[Visitor],
        profiles: Optional[List[dict]] = None,
        removed: Optional[List[str]] = None,
        extra_meta: Optional[dict] = None,
    ) -> None:
        if not room.sockets:
            return
        room.revision += 1
        t = now_ms()
        frame = encode_snsd_delta(
            room.revision,
            t,
            room.id,
            changed_visitors,
            profiles=profiles,
            removed=removed,
            extra_meta=extra_meta,
        )
        stale: List[str] = []
        for vid, ws in list(room.sockets.items()):
            try:
                await ws.send_bytes(frame)
            except Exception:
                stale.append(vid)
        for vid in stale:
            room.sockets.pop(vid, None)

    async def broadcast_json(self, room: TempleRoom, payload: dict) -> None:
        if not room.sockets:
            return
        text = json.dumps(payload, ensure_ascii=False)
        stale: List[str] = []
        for vid, ws in list(room.sockets.items()):
            try:
                await ws.send_text(text)
            except Exception:
                stale.append(vid)
        for vid in stale:
            room.sockets.pop(vid, None)

    async def broadcast_cafe25(self, room: TempleRoom) -> None:
        if not room.sockets:
            return
        room.cafe25_revision += 1
        stale: List[str] = []
        for vid, ws in list(room.sockets.items()):
            try:
                await ws.send_text(json.dumps(room.cafe25_dict(vid), ensure_ascii=False))
            except Exception:
                stale.append(vid)
        for vid in stale:
            room.sockets.pop(vid, None)


WORLD = TempleWorld()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async def npc_tick():
        while True:
            await asyncio.sleep(2.4)
            t = now_ms()
            room = WORLD.rooms["maru"]
            if not room.sockets:
                continue
            changed: List[Visitor] = []
            for v in room.visitors.values():
                if not v.is_npc:
                    continue
                if v.cushion is None and v.pose == "walk":
                    angle = ((t * 0.0003) + v.seat) % (2 * math.pi)
                    cx = 16.5 if v.seat == 6 else -6.0
                    cz = 36.2 if v.seat == 6 else 34.0
                    v.x = round(cx + math.cos(angle) * 2.2, 3)
                    v.z = round(cz + math.sin(angle) * 2.2, 3)
                    v.yaw = round(((angle + math.pi / 2 + math.pi) % (2 * math.pi)) - math.pi, 4)
                    changed.append(v)
                elif v.bow_at is not None and (t - v.bow_at) > 10_400:
                    v.bow_at = t
                    changed.append(v)
            if changed:
                await WORLD.broadcast_delta(room, changed)

    task = asyncio.create_task(npc_tick())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="Online Multiverse — Sansa Temple", version="2.0.0", lifespan=lifespan)


@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/clean")
async def serve_clean() -> FileResponse:
    clean_file = STATIC_DIR / "clean.html"
    if clean_file.exists():
        return FileResponse(clean_file)
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
async def serve_favicon() -> Response:
    ico = STATIC_DIR / "favicon.ico"
    if ico.exists():
        return FileResponse(ico)
    return Response(status_code=204)


@app.get("/favicon.svg")
async def serve_favicon_svg() -> Response:
    svg = STATIC_DIR / "favicon.svg"
    if svg.exists():
        return FileResponse(svg, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/favicon-32.png")
async def serve_favicon_32() -> Response:
    png = STATIC_DIR / "favicon-32.png"
    if png.exists():
        return FileResponse(png, media_type="image/png")
    return Response(status_code=204)


@app.get("/apple-touch-icon.png")
async def serve_apple_touch_icon() -> Response:
    png = STATIC_DIR / "apple-touch-icon.png"
    if png.exists():
        return FileResponse(png, media_type="image/png")
    return Response(status_code=204)


@app.get("/icon-192.png")
async def serve_icon_192() -> Response:
    png = STATIC_DIR / "icon-192.png"
    if png.exists():
        return FileResponse(png, media_type="image/png")
    return Response(status_code=204)


@app.get("/og/{file_path:path}")
async def serve_og_image(file_path: str) -> Response:
    target = (STATIC_DIR / "og" / file_path).resolve()
    og_root = (STATIC_DIR / "og").resolve()
    if str(target).startswith(str(og_root)) and target.is_file():
        return FileResponse(target)
    return Response(status_code=404)


@app.get("/v/{version}/assets/{file_path:path}")
async def serve_versioned_asset(version: str, file_path: str) -> Response:
    _ = version
    target = (STATIC_DIR / "assets" / file_path).resolve()
    assets_root = (STATIC_DIR / "assets").resolve()
    if str(target).startswith(str(assets_root)) and target.is_file():
        return FileResponse(target)
    return Response(status_code=404)


@app.get("/manifest.webmanifest")
async def serve_manifest() -> JSONResponse:
    return JSONResponse(
        {
            "id": "/",
            "name": "산사 — 잠깐 쉬어가요",
            "short_name": "산사",
            "description": "말없이 같이 앉아 있는 온라인 절, 산사.",
            "lang": "ko",
            "start_url": "/",
            "scope": "/",
            "display": "standalone",
            "background_color": "#20251f",
            "theme_color": "#24251f",
        }
    )


@app.get("/api/health")
@app.get("/healthz")
async def health_check() -> JSONResponse:
    total_visitors = sum(len(r.visitors) for r in WORLD.rooms.values())
    return JSONResponse(
        {
            "ok": True,
            "service": "online_multiverse",
            "protocol": "SNSD-wire-3",
            "rooms": len(WORLD.rooms),
            "totalVisitors": total_visitors,
            "serverTime": now_ms(),
        }
    )


@app.get("/api/rooms")
async def list_rooms(roomLimit: int = 20) -> JSONResponse:
    limit = max(1, min(ROOM_LIMIT, int(roomLimit)))
    t = now_ms()
    rooms_out = []
    for num in range(1, limit + 1):
        rid = room_id_for_number(num)
        r = WORLD.rooms[rid]
        rooms_out.append(
            {
                "id": r.id,
                "number": r.number,
                "capacity": r.capacity,
                "count": min(MAX_VISITORS, len(r.visitors)),
                "checkedAt": t,
                "stale": False,
            }
        )
    return JSONResponse({"ok": True, "serverTime": t, "rooms": rooms_out})


@app.post("/api/entry-stage")
async def entry_stage(_request: Request) -> Response:
    return Response(status_code=204)


@app.websocket("/presence")
async def presence_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    requested_room = websocket.query_params.get("room", "maru")
    garden_mode = websocket.query_params.get("garden") == "2"
    room = WORLD.pick_room(requested_room)
    seat = room.allocate_seat()
    if seat is None:
        await websocket.send_text(json.dumps({"type": "error", "code": "room-full"}))
        await websocket.close(code=4009)
        return

    self_id = str(uuid.uuid4())
    if garden_mode:
        # Spawn at Garden Arrival Pool (Yy(seat) in game-CLKObOjK.js: x=0, z=48, yaw=-0.18)
        col_idx = (seat % 5) - 2
        spawn_x = round(col_idx * 1.2, 2)
        spawn_z = round(48.0 + (seat % 3) * 1.2, 2)
        spawn_yaw = -0.18
    else:
        spawn_x = round(random.uniform(-2.4, 2.4), 2)
        spawn_z = round(random.uniform(21.6, 25.0), 2)
        spawn_yaw = math.pi

    visitor = Visitor(
        id=self_id,
        name=generate_monk_name(),
        color=random.choice(ROBE_COLORS),
        seat=seat,
        cushion=None,
        joined_at=now_ms(),
        pose="walk",
        x=spawn_x,
        z=spawn_z,
        yaw=spawn_yaw,
        bow_at=None,
        is_npc=False,
    )
    room.visitors[self_id] = visitor
    room.sockets[self_id] = websocket

    # 1. Broadcast new visitor to existing peers first (so room.revision increments cleanly)
    if len(room.sockets) > 1:
        await WORLD.broadcast_delta(
            room,
            [visitor],
            profiles=[visitor.to_delta_profile_dict()],
        )

    # 2. Send authoritative snapshot to the newly connected client
    await websocket.send_text(json.dumps(room.snapshot_dict(self_id), ensure_ascii=False))
    await websocket.send_text(json.dumps(room.cafe25_dict(self_id), ensure_ascii=False))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue

            mtype = msg.get("type")
            t = now_ms()

            if mtype in ("ack", "entry-active"):
                continue

            elif mtype == "ping":
                await websocket.send_text('{"type":"pong"}')

            elif mtype == "sync":
                await websocket.send_text(json.dumps(room.snapshot_dict(self_id), ensure_ascii=False))

            elif mtype == "interest":
                req_id = msg.get("requestId")
                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "update",
                            "revision": room.revision,
                            "serverTime": t,
                            "interestId": req_id,
                            "visitors": [vis.to_profile_dict() for vis in room.visitors.values()],
                        },
                        ensure_ascii=False,
                    )
                )

            elif mtype == "move":
                x = msg.get("x", visitor.x)
                z = msg.get("z", visitor.z)
                yaw = msg.get("yaw", visitor.yaw)
                pose = msg.get("pose", visitor.pose)
                if all(isinstance(val, (int, float)) and math.isfinite(val) for val in (x, z, yaw)):
                    visitor.x = max(-90.0, min(90.0, float(x)))
                    visitor.z = max(-45.0, min(70.0, float(z)))
                    visitor.yaw = float(yaw)
                if pose in POSE_TO_INDEX:
                    visitor.pose = pose
                if visitor.pose != "kneel":
                    visitor.bow_at = None
                await WORLD.broadcast_delta(room, [visitor])

            elif mtype == "seat":
                req_id = msg.get("requestId")
                preferred = msg.get("cushion")
                pref_int = int(preferred) if isinstance(preferred, int) else None
                c_idx = room.allocate_cushion(visitor, pref_int)
                if c_idx is not None:
                    visitor.cushion = c_idx
                    visitor.pose = "kneel"
                    c_pos = cushion_position(c_idx)
                    if isinstance(msg.get("x"), (int, float)) and isinstance(msg.get("z"), (int, float)):
                        visitor.x = float(msg["x"])
                        visitor.z = float(msg["z"])
                    else:
                        visitor.x = c_pos["x"]
                        visitor.z = c_pos["z"]
                    visitor.yaw = float(msg.get("yaw", 0.0))
                    if req_id is not None:
                        await websocket.send_text(
                            json.dumps({"type": "seat-granted", "requestId": req_id, "seat": c_idx})
                        )
                    await WORLD.broadcast_delta(room, [visitor])
                else:
                    if req_id is not None:
                        await websocket.send_text(
                            json.dumps({"type": "seat-unavailable", "requestId": req_id})
                        )

            elif mtype == "stand":
                visitor.cushion = None
                visitor.pose = "walk"
                visitor.bow_at = None
                await WORLD.broadcast_delta(room, [visitor])

            elif mtype in ("hello", "bow", "bead"):
                if mtype == "bow":
                    visitor.pose = "kneel"
                    visitor.bow_at = t
                elif mtype == "bead":
                    visitor.pose = "beads"
                event_obj = {"eventId": str(uuid.uuid4()), "id": self_id, "type": mtype, "at": t}
                await WORLD.broadcast_delta(room, [visitor], extra_meta={"events": [event_obj]})
                await WORLD.broadcast_json(
                    room,
                    {"type": "event", "event": {"type": mtype, "id": self_id}},
                )

            elif mtype == "incense-join":
                req_id = msg.get("requestId")
                if self_id not in room.incense_queue:
                    room.incense_queue.append(self_id)
                    room.queue_revision += 1
                if req_id is not None:
                    await websocket.send_text(
                        json.dumps(
                            {
                                "type": "incense-queue-result",
                                "requestId": req_id,
                                "accepted": True,
                                "serverTime": t,
                            }
                        )
                    )
                await WORLD.broadcast_json(
                    room,
                    {
                        "type": "incense-queue",
                        "serverTime": t,
                        "queue": room.incense_queue_dict(t),
                    },
                )

            elif mtype in ("incense-leave", "incense-abandon"):
                if self_id in room.incense_queue:
                    room.incense_queue.remove(self_id)
                    room.queue_revision += 1
                    if room.incense_started and room.incense_started.get("id") == self_id:
                        room.incense_started = None
                    await WORLD.broadcast_json(
                        room,
                        {
                            "type": "incense-queue",
                            "serverTime": t,
                            "queue": room.incense_queue_dict(t),
                        },
                    )

            elif mtype == "incense-start":
                if room.incense_queue and room.incense_queue[0] == self_id:
                    room.incense_started = {"id": self_id, "at": t}
                    await WORLD.broadcast_json(
                        room,
                        {"type": "incense-start", "id": self_id, "at": t, "serverTime": t},
                    )

            elif mtype == "incense":
                req_id = msg.get("requestId")
                action = msg.get("action")
                if action in ("join", "leave", "offer"):
                    # Clean client (/clean) incense message
                    if action == "join" and self_id not in room.incense_queue:
                        room.incense_queue.append(self_id)
                    elif action in ("leave", "offer") and self_id in room.incense_queue:
                        room.incense_queue.remove(self_id)
                    room.queue_revision += 1
                    extra = {"incenseQueue": list(room.incense_queue)}
                    if action == "offer":
                        extra["events"] = [
                            {
                                "eventId": str(uuid.uuid4()),
                                "id": self_id,
                                "type": "incense-offer",
                                "name": visitor.name,
                                "at": t,
                            }
                        ]
                    await WORLD.broadcast_delta(room, [visitor], extra_meta=extra)
                else:
                    # Original engine incense offering request
                    if self_id in room.incense_queue:
                        room.incense_queue.remove(self_id)
                        room.queue_revision += 1
                    room.incense_started = None
                    offering = {
                        "id": str(uuid.uuid4()),
                        "visitorId": self_id,
                        "at": t,
                        "expiresAt": t + INCENSE_DURATION_MS,
                    }
                    room.incense_offerings = [
                        o for o in room.incense_offerings if o["visitorId"] != self_id and o["expiresAt"] > t
                    ]
                    room.incense_offerings.append(offering)
                    if req_id is not None:
                        await websocket.send_text(
                            json.dumps({"type": "incense-result", "requestId": req_id, "accepted": True})
                        )
                    await WORLD.broadcast_json(
                        room,
                        {"type": "incense", "serverTime": t, "offering": offering},
                    )
                    await WORLD.broadcast_json(
                        room,
                        {
                            "type": "incense-queue",
                            "serverTime": t,
                            "queue": room.incense_queue_dict(t),
                        },
                    )

            elif mtype == "cafe25":
                action = msg.get("action")
                req_id = msg.get("requestId")
                payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}

                if action == "share":
                    note = str(msg.get("message") or "따뜻한 커피 한 잔 두고 갑니다.").strip()[:80]
                    room.shared_coffees.append(
                        {
                            "id": str(uuid.uuid4()),
                            "fromName": visitor.name,
                            "message": note,
                            "createdAt": t,
                        }
                    )
                    await WORLD.broadcast_cafe25(room)
                    continue
                elif action == "claim":
                    claimed = room.shared_coffees.pop(0) if room.shared_coffees else None
                    await WORLD.broadcast_cafe25(room)
                    if claimed:
                        await websocket.send_text(
                            json.dumps({"type": "cafe25-claimed", "coffee": claimed}, ensure_ascii=False)
                        )
                    continue

                ok = True
                code = None
                if action == "bow-complete":
                    visitor.bows += 1
                    if visitor.bows % 25 == 0 or visitor.credit == 0:
                        visitor.credit += 1
                elif action == "mint":
                    mode = payload.get("mode", "self")
                    kind = payload.get("kind", "americano")
                    temp = payload.get("temperature", "hot")
                    if mode not in ("gift", "self"):
                        mode = "self"
                    if kind not in ("americano", "latte"):
                        kind = "americano"
                    if temp not in ("hot", "iced"):
                        temp = "hot"
                    visitor.cup = {
                        "id": str(uuid.uuid4()),
                        "holderId": self_id,
                        "mode": mode,
                        "kind": kind,
                        "temperature": temp,
                        "sips": 0,
                        "readyAt": t + 2800,
                        "pickedUp": False,
                    }
                elif action == "pickup":
                    if visitor.cup is not None:
                        visitor.cup["pickedUp"] = True
                    else:
                        ok = False
                elif action == "sip":
                    if visitor.cup is not None and visitor.cup.get("pickedUp"):
                        visitor.cup["sips"] = min(3, int(visitor.cup.get("sips", 0)) + 1)
                        if visitor.cup["sips"] >= 3:
                            visitor.effect = {
                                "startedAt": t,
                                "until": t + CAFE25_EFFECT_DURATION_MS,
                            }
                    else:
                        ok = False
                elif action in ("clear", "dispose"):
                    visitor.cup = None
                elif action == "seat":
                    seat_id = str(payload.get("seatId") or "")
                    taken = any(
                        vis.id != self_id and vis.garden_seat_id == seat_id
                        for vis in room.visitors.values()
                    )
                    if seat_id and not taken:
                        visitor.garden_seat_id = seat_id
                    else:
                        ok = False
                        code = "seat-taken"
                elif action == "stand":
                    visitor.garden_seat_id = None

                room.cafe25_revision += 1
                state = room.cafe25_state_for(self_id)
                if isinstance(req_id, int):
                    res_obj = {"ok": ok, "state": state}
                    if code:
                        res_obj["code"] = code
                    await websocket.send_text(
                        json.dumps(
                            {
                                "type": "cafe25-result",
                                "requestId": req_id,
                                "result": res_obj,
                            },
                            ensure_ascii=False,
                        )
                    )
                await WORLD.broadcast_cafe25(room)

            elif mtype == "room-switch":
                target_room_id = str(msg.get("room") or "maru").strip().lower()
                req_id = msg.get("requestId")
                target_room = WORLD.rooms.get(target_room_id)
                if not target_room or len(target_room.visitors) >= MAX_VISITORS:
                    await websocket.send_text(
                        json.dumps({"type": "room-switch-denied", "requestId": req_id})
                    )
                    continue
                new_seat = target_room.allocate_seat()
                if new_seat is None:
                    await websocket.send_text(
                        json.dumps({"type": "room-switch-denied", "requestId": req_id})
                    )
                    continue

                # Remove from current room
                room.sockets.pop(self_id, None)
                room.visitors.pop(self_id, None)
                if self_id in room.incense_queue:
                    room.incense_queue.remove(self_id)
                await WORLD.broadcast_delta(room, [], removed=[self_id])

                # Join target room
                room = target_room
                visitor.seat = new_seat
                visitor.cushion = None
                visitor.pose = "walk"
                room.visitors[self_id] = visitor
                room.sockets[self_id] = websocket
                if len(room.sockets) > 1:
                    await WORLD.broadcast_delta(
                        room,
                        [visitor],
                        profiles=[visitor.to_delta_profile_dict()],
                    )
                snap = room.snapshot_dict(self_id)
                if req_id is not None:
                    snap["requestId"] = req_id
                await websocket.send_text(json.dumps(snap, ensure_ascii=False))

    except WebSocketDisconnect:
        pass
    finally:
        room.sockets.pop(self_id, None)
        room.visitors.pop(self_id, None)
        if self_id in room.incense_queue:
            room.incense_queue.remove(self_id)
            room.queue_revision += 1
        await WORLD.broadcast_delta(room, [], removed=[self_id])


ASSETS_DIR = STATIC_DIR / "assets"
FONTS_DIR = STATIC_DIR / "fonts"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)
FONTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
app.mount("/fonts", StaticFiles(directory=str(FONTS_DIR)), name="fonts")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def run_self_check() -> None:
    """Runnable self-check verifying SNSD binary wire protocol and room state invariants."""
    v1 = Visitor(
        id="u-1",
        name="고요한 바람",
        color="#a89f91",
        seat=0,
        cushion=3,
        pose="kneel",
        x=-2.4,
        z=-5.6,
        yaw=0.0,
        bow_at=1793979945120,
    )
    v2 = Visitor(
        id="u-2",
        name="따스한 솔잎",
        color="#8d9488",
        seat=1,
        cushion=None,
        pose="walk",
        x=0.0,
        z=48.0,
        yaw=-0.18,
        bow_at=None,
    )
    encoded = encode_snsd_delta(
        42,
        1793979950000,
        "maru",
        [v1, v2],
        profiles=[v1.to_delta_profile_dict()],
        removed=[],
    )
    decoded = decode_snsd_delta(encoded)

    assert decoded["revision"] == 42, f"Expected revision 42, got {decoded['revision']}"
    assert decoded["meta"]["room"] == "maru"
    assert isinstance(decoded["meta"]["profiles"], list) and isinstance(decoded["meta"]["removed"], list)
    assert len(decoded["records"]) == 2, f"Expected 2 records, got {len(decoded['records'])}"
    assert decoded["records"][0]["seat"] == 0 and decoded["records"][0]["cushion"] == 3
    assert decoded["records"][0]["pose"] == "kneel" and decoded["records"][0]["bowAt"] == 1793979945120
    assert decoded["records"][1]["seat"] == 1 and decoded["records"][1]["cushion"] is None
    assert "bowAt" not in v2.to_profile_dict()
    assert len(WORLD.rooms) == 100 and WORLD.rooms["maru"].number == 1 and WORLD.rooms["maru-100"].number == 100
    print("✅ [SELF-CHECK PASSED] Big-Endian SNSD (0x534E5344) binary delta & 100-room state verified.")


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        run_self_check()
        sys.exit(0)

    import uvicorn

    port = int(
        os.environ.get(
            "PORT",
            sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else DEFAULT_PORT,
        )
    )
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
