#!/usr/bin/env python3
"""
Online_Multiverse — 산사 (Sansa Temple) 3D Silent Co-presence Server
FastAPI + WebSocket + SNSD (0x534E5344) Hybrid Binary Delta Protocol (Port 8860)
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

SNSD_MAGIC = 0x534E5344  # ASCII "SNSD" (1397642035)
ROOM_CAPACITY = 100
ROOM_LIMIT = 100
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


def now_ms() -> float:
    return round(time.time() * 1000.0, 2)


def room_id_for_number(num: int) -> str:
    return "maru" if num == 1 else f"maru-{num:02d}"


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
    joined_at: float = field(default_factory=now_ms)
    pose: str = "walk"
    x: float = 0.0
    z: float = 28.0
    yaw: float = 0.0
    bow_at: Optional[float] = None
    is_npc: bool = False

    def to_profile_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "seat": self.seat,
            "cushion": self.cushion,
            "joinedAt": self.joined_at,
            "pose": self.pose,
            "position": {"x": round(self.x, 3), "z": round(self.z, 3), "yaw": round(self.yaw, 4)},
            **({"bowAt": self.bow_at} if self.bow_at is not None else {}),
        }


def encode_snsd_delta(
    revision: int,
    server_time: float,
    meta: dict,
    visitors: List[Visitor],
) -> bytes:
    """
    Pack a wire=3 SNSD (0x534E5344) binary delta frame:
    - 28-byte little-endian header: magic(u32), jsonByteLength(u32), recordCount(u32), revision(f64), serverTime(f64)
    - UTF-8 JSON metadata bytes (profiles, removed, events, incenseQueue)
    - N visitor binary records: 30 bytes (or 38 bytes when hasBow == 1)
    """
    json_bytes = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if meta else b""
    header = struct.pack(
        "<IIIdd",
        SNSD_MAGIC,
        len(json_bytes),
        len(visitors),
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
                    "<HhBBdddd",
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
                    "<HhBBddd",
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
    magic, json_len, record_count, revision, server_time = struct.unpack_from("<IIIdd", payload, 0)
    if magic != SNSD_MAGIC:
        raise ValueError(f"Invalid SNSD magic: {hex(magic)}")
    offset = 28
    meta = {}
    if json_len > 0:
        meta = json.loads(payload[offset : offset + json_len].decode("utf-8"))
        offset += json_len
    records = []
    for _ in range(record_count):
        seat, cushion, pose_idx, has_bow, x, z, yaw = struct.unpack_from("<HhBBddd", payload, offset)
        offset += 30
        bow_at = None
        if has_bow == 1:
            (bow_at,) = struct.unpack_from("<d", payload, offset)
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
        "serverTime": server_time,
        "meta": meta,
        "records": records,
    }


class TempleRoom:
    def __init__(self, room_id: str, number: int):
        self.id = room_id
        self.number = number
        self.capacity = ROOM_CAPACITY
        self.revision = 1
        self.visitors: Dict[str, Visitor] = {}
        self.sockets: Dict[str, WebSocket] = {}
        self.incense_queue: List[str] = []
        self.shared_coffees: List[dict] = []
        self.donations: List[dict] = []
        self._seed_ambient_visitors()

    def _seed_ambient_visitors(self) -> None:
        """Seed peaceful silent co-presence monks in primary rooms."""
        npc_counts = {1: 6, 2: 2, 3: 1}
        count = npc_counts.get(self.number, 0)
        presets = [
            # Hall meditators/bowers on cushions (z < 0 is inside Hall, z >= 0 is Garden)
            {"cushion": 2, "pose": "kneel", "x": -3.6, "z": -6.5, "yaw": math.pi, "bow": True},
            {"cushion": 5, "pose": "kneel", "x": 3.6, "z": -6.5, "yaw": math.pi, "bow": False},
            {"cushion": 9, "pose": "beads", "x": -1.2, "z": -9.0, "yaw": math.pi, "bow": False},
            # Garden visitors (by lotus pond bench, strolling path, cafe25 bench)
            {"cushion": 100, "pose": "kneel", "x": -7.5, "z": 10.0, "yaw": 0.4, "bow": False},
            {"cushion": None, "pose": "walk", "x": 5.2, "z": 19.5, "yaw": -0.6, "bow": False},
            {"cushion": 102, "pose": "beads", "x": 7.5, "z": 10.5, "yaw": -0.5, "bow": False},
        ]
        t = now_ms()
        for i in range(count):
            p = presets[i % len(presets)]
            vid = f"npc-{self.number}-{i+1}"
            self.visitors[vid] = Visitor(
                id=vid,
                name=generate_monk_name(self.number * 100 + i),
                color=ROBE_COLORS[(self.number + i) % len(ROBE_COLORS)],
                seat=i,
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
            self.shared_coffees.append(
                {
                    "id": str(uuid.uuid4()),
                    "fromName": "고요한 달빛",
                    "message": "잠시 숨을 고르고 따뜻한 차 한 잔 드세요.",
                    "createdAt": t - 45_000,
                }
            )

    def allocate_seat(self) -> Optional[int]:
        used: Set[int] = {v.seat for v in self.visitors.values()}
        for s in range(self.capacity):
            if s not in used:
                return s
        return None

    def allocate_cushion(self, preferred: Optional[int] = None) -> Optional[int]:
        occupied = {v.cushion for v in self.visitors.values() if v.cushion is not None}
        if preferred is not None and 0 <= preferred < 200 and preferred not in occupied:
            return preferred
        for c in range(24):
            if c not in occupied:
                return c
        return None

    def snapshot_dict(self, self_id: str) -> dict:
        return {
            "type": "snapshot",
            "room": self.id,
            "region": "apac",
            "instance": "0",
            "selfId": self_id,
            "revision": self.revision,
            "serverTime": now_ms(),
            "incenseQueue": list(self.incense_queue),
            "visitors": [v.to_profile_dict() for v in self.visitors.values()],
        }

    def cafe25_dict(self, self_id: str = "") -> dict:
        return {
            "type": "cafe25-state",
            "room": self.id,
            "revision": self.revision,
            "serverTime": now_ms(),
            "selfId": self_id,
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
        meta: Optional[dict] = None,
    ) -> None:
        if not room.sockets:
            return
        room.revision += 1
        frame = encode_snsd_delta(room.revision, now_ms(), meta or {}, changed_visitors)
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
                    angle = (t * 0.00035) + v.seat
                    v.x = round(5.0 + math.cos(angle) * 2.6, 3)
                    v.z = round(18.5 + math.sin(angle) * 2.6, 3)
                    v.yaw = round(angle + math.pi / 2, 4)
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


app = FastAPI(title="Online Multiverse — Sansa Temple", version="1.0.0", lifespan=lifespan)


@app.get("/")
async def serve_index() -> FileResponse:
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


@app.get("/icon-192.png")
async def serve_icon_192() -> Response:
    png = STATIC_DIR / "icon-192.png"
    if png.exists():
        return FileResponse(png, media_type="image/png")
    return Response(status_code=204)


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
async def health_check() -> JSONResponse:
    total_visitors = sum(len(r.visitors) for r in WORLD.rooms.values())
    return JSONResponse(
        {
            "ok": True,
            "service": "online_multiverse",
            "protocol": "SNSD-wire-3",
            "rooms": len(WORLD.rooms),
            "totalVisitors": total_visitors,
        }
    )


@app.get("/api/rooms")
async def list_rooms(roomLimit: int = 100) -> JSONResponse:
    limit = max(1, min(ROOM_LIMIT, int(roomLimit)))
    rooms_out = []
    for num in range(1, limit + 1):
        rid = room_id_for_number(num)
        r = WORLD.rooms[rid]
        rooms_out.append(
            {
                "id": r.id,
                "number": r.number,
                "capacity": r.capacity,
                "count": len(r.visitors),
            }
        )
    return JSONResponse({"ok": True, "rooms": rooms_out})


@app.post("/api/entry-stage")
async def entry_stage(_request: Request) -> Response:
    return Response(status_code=204)


@app.websocket("/presence")
async def presence_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    requested_room = websocket.query_params.get("room", "auto")
    room = WORLD.pick_room(requested_room)
    seat = room.allocate_seat()
    if seat is None:
        await websocket.send_text(json.dumps({"type": "error", "code": "room-full"}))
        await websocket.close()
        return

    self_id = str(uuid.uuid4())
    spawn_x = round(random.uniform(-3.2, 3.2), 2)
    spawn_z = round(random.uniform(22.0, 27.0), 2)
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
        yaw=math.pi,
        bow_at=None,
        is_npc=False,
    )
    room.visitors[self_id] = visitor
    room.sockets[self_id] = websocket

    # 1. Send initial snapshot & cafe25 state
    await websocket.send_text(json.dumps(room.snapshot_dict(self_id), ensure_ascii=False))
    await websocket.send_text(json.dumps(room.cafe25_dict(self_id), ensure_ascii=False))

    # 2. Broadcast new profile + binary position record to peers
    await WORLD.broadcast_delta(
        room,
        [visitor],
        meta={"room": room.id, "profiles": [visitor.to_profile_dict()]},
    )

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

            if mtype in ("ack", "interest", "entry-active"):
                continue

            elif mtype == "move":
                x = msg.get("x", visitor.x)
                z = msg.get("z", visitor.z)
                yaw = msg.get("yaw", visitor.yaw)
                pose = msg.get("pose", visitor.pose)
                if all(isinstance(val, (int, float)) and math.isfinite(val) for val in (x, z, yaw)):
                    visitor.x = max(-60.0, min(60.0, float(x)))
                    visitor.z = max(-45.0, min(65.0, float(z)))
                    visitor.yaw = float(yaw)
                if pose in POSE_TO_INDEX:
                    visitor.pose = pose
                if visitor.pose != "kneel":
                    visitor.bow_at = None
                await WORLD.broadcast_delta(room, [visitor])

            elif mtype == "seat":
                preferred = msg.get("cushion")
                pref_int = int(preferred) if isinstance(preferred, int) else None
                c_idx = room.allocate_cushion(pref_int)
                if c_idx is not None:
                    visitor.cushion = c_idx
                    visitor.pose = "kneel"
                    if isinstance(msg.get("x"), (int, float)) and isinstance(msg.get("z"), (int, float)):
                        visitor.x = float(msg["x"])
                        visitor.z = float(msg["z"])
                    if isinstance(msg.get("yaw"), (int, float)):
                        visitor.yaw = float(msg["yaw"])
                    await WORLD.broadcast_delta(room, [visitor])

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
                await WORLD.broadcast_delta(room, [visitor], meta={"events": [event_obj]})

            elif mtype == "incense":
                action = msg.get("action")
                if action == "join" and self_id not in room.incense_queue:
                    room.incense_queue.append(self_id)
                elif action in ("leave", "offer"):
                    if self_id in room.incense_queue:
                        room.incense_queue.remove(self_id)
                event_meta = {"incenseQueue": list(room.incense_queue)}
                if action == "offer":
                    event_meta["events"] = [
                        {
                            "eventId": str(uuid.uuid4()),
                            "id": self_id,
                            "type": "incense-offer",
                            "name": visitor.name,
                            "at": t,
                        }
                    ]
                await WORLD.broadcast_delta(room, [visitor], meta=event_meta)

            elif mtype == "cafe25":
                action = msg.get("action")
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
                    await WORLD.broadcast_json(room, room.cafe25_dict())
                elif action == "claim":
                    claimed = room.shared_coffees.pop(0) if room.shared_coffees else None
                    await WORLD.broadcast_json(room, room.cafe25_dict())
                    if claimed:
                        await websocket.send_text(
                            json.dumps(
                                {
                                    "type": "cafe25-claimed",
                                    "coffee": claimed,
                                },
                                ensure_ascii=False,
                            )
                        )
    except WebSocketDisconnect:
        pass
    finally:
        room.sockets.pop(self_id, None)
        room.visitors.pop(self_id, None)
        if self_id in room.incense_queue:
            room.incense_queue.remove(self_id)
        await WORLD.broadcast_delta(room, [], meta={"room": room.id, "removed": [self_id]})


ASSETS_DIR = STATIC_DIR / "assets"
FONTS_DIR = STATIC_DIR / "fonts"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)
FONTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
app.mount("/fonts", StaticFiles(directory=str(FONTS_DIR)), name="fonts")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def run_self_check() -> None:
    """Runnable self-check verifying SNSD binary wire protocol and room state invariants."""
    v1 = Visitor(id="u-1", name="고요한 바람", color="#a89f91", seat=0, cushion=3, pose="kneel", x=-2.4, z=-6.8, yaw=3.1415, bow_at=1793979945120.0)
    v2 = Visitor(id="u-2", name="따스한 솔잎", color="#8d9488", seat=1, cushion=None, pose="walk", x=4.5, z=18.2, yaw=-0.5, bow_at=None)
    meta_in = {"room": "maru", "profiles": [v1.to_profile_dict()], "events": [{"eventId": "ev-1", "id": "u-1", "type": "bow"}]}
    encoded = encode_snsd_delta(42, 1793979950000.0, meta_in, [v1, v2])
    decoded = decode_snsd_delta(encoded)

    assert decoded["revision"] == 42, f"Expected revision 42, got {decoded['revision']}"
    assert len(decoded["records"]) == 2, f"Expected 2 records, got {len(decoded['records'])}"
    assert decoded["records"][0]["seat"] == 0 and decoded["records"][0]["cushion"] == 3
    assert decoded["records"][0]["pose"] == "kneel" and decoded["records"][0]["bowAt"] == 1793979945120.0
    assert decoded["records"][1]["seat"] == 1 and decoded["records"][1]["cushion"] is None
    assert math.isclose(decoded["records"][1]["x"], 4.5, rel_tol=1e-6)
    assert len(WORLD.rooms) == 100 and WORLD.rooms["maru"].number == 1 and WORLD.rooms["maru-100"].number == 100
    print("✅ [SELF-CHECK PASSED] SNSD (0x534E5344) binary delta encode/decode & 100-room state verified.")


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        run_self_check()
        sys.exit(0)

    import uvicorn

    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else DEFAULT_PORT))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
