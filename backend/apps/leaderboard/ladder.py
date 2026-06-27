"""
爬梯競速 v2 — 自動移動競速版
=============================
地圖：5 條軌道（col 0-4），20 格高（row 0 = 終點頂部，row 19 = 起點底部）
橫棧：連接相鄰軌道，玩家到達橫棧時自動橫越到另一條軌道
每 tick 有 80% 機率前進一格（製造賽跑差距），先抵達 row 0 者勝
"""
import random
import string
import time

# ── Constants ──────────────────────────────────────────────────────────────────
NUM_COLS       = 5
NUM_ROWS       = 20
FINISH_ROW     = 0    # 終點在最上方
START_ROW      = 19   # 起點在最下方
TICK_INTERVAL  = 0.4  # 每 tick 間隔（秒）
MOVE_PROB      = 0.8  # 每 tick 前進的機率（製造賽跑隨機性）
MAX_PLAYERS    = 5
SELECTION_TIME = 15   # 選位倒數秒數

PLAYER_COLORS = ['#00ff88', '#ff6b6b', '#4ecdc4', '#f7dc6f', '#c084fc']

# ── 橫棧定義 ──────────────────────────────────────────────────────────────────
# (row, col_left, col_right) — 在 row 行連接兩條相鄰軌道
RUNGS: list[tuple[int, int, int]] = [
    (3,  0, 1),
    (5,  3, 4),
    (7,  1, 2),
    (9,  2, 3),
    (11, 0, 1),
    (12, 3, 4),
    (14, 1, 2),
    (15, 2, 3),
    (17, 0, 1),
    (18, 1, 2),
    (18, 3, 4),
]

# Build rung lookup: (row, col) -> other_col
RUNG_MAP: dict[tuple[int, int], int] = {}
for _row, _c1, _c2 in RUNGS:
    RUNG_MAP[(_row, _c1)] = _c2
    RUNG_MAP[(_row, _c2)] = _c1


# ── Player ────────────────────────────────────────────────────────────────────
class Player:
    def __init__(self, pid: str, nickname: str, color: str, start_col: int) -> None:
        self.pid          = pid
        self.nickname     = nickname
        self.color        = color
        self.col          = start_col
        self.row          = START_ROW
        self.finished     = False
        self.finish_rank: int | None = None

    def to_dict(self) -> dict:
        return {
            'pid':         self.pid,
            'nickname':    self.nickname,
            'color':       self.color,
            'col':         self.col,
            'row':         self.row,
            'finished':    self.finished,
            'finish_rank': self.finish_rank,
        }


# ── LadderRoom ────────────────────────────────────────────────────────────────
class LadderRoom:
    def __init__(self, room_code: str, host_id: str) -> None:
        self.room_code      = room_code
        self.host_id        = host_id
        self.lobby: dict[str, dict]     = {}  # pid -> info dict
        self.players: dict[str, Player] = {}  # pid -> Player (during game)
        self.selected_cols: dict[str, int] = {}
        self.state          = 'lobby'
        self.tick_task      = None
        self.finish_counter = 0

    # ── Lobby ─────────────────────────────────────────────────────────────────
    def add_lobby_player(self, pid: str, nickname: str) -> bool:
        if len(self.lobby) >= MAX_PLAYERS:
            return False
        self.lobby[pid] = {
            'pid':      pid,
            'nickname': nickname,
            'color':    PLAYER_COLORS[len(self.lobby)],
            'is_host':  pid == self.host_id,
        }
        return True

    def remove_player(self, pid: str) -> None:
        self.lobby.pop(pid, None)
        self.players.pop(pid, None)
        self.selected_cols.pop(pid, None)

    def lobby_list(self) -> list[dict]:
        return list(self.lobby.values())

    # ── Selection ─────────────────────────────────────────────────────────────
    def select_col(self, pid: str, col: int) -> bool:
        if col not in range(NUM_COLS):
            return False
        taken = {v for k, v in self.selected_cols.items() if k != pid}
        if col in taken:
            return False
        self.selected_cols[pid] = col
        return True

    def auto_assign(self) -> None:
        """Assign random columns to players who haven't selected."""
        used = set(self.selected_cols.values())
        available = [c for c in range(NUM_COLS) if c not in used]
        random.shuffle(available)
        for pid in self.lobby:
            if pid not in self.selected_cols and available:
                self.selected_cols[pid] = available.pop(0)

    def build_players(self) -> None:
        """Create Player objects from lobby + selected_cols."""
        for pid, info in self.lobby.items():
            col = self.selected_cols.get(pid, 0)
            self.players[pid] = Player(
                pid, info['nickname'], info['color'], col
            )

    # ── Game tick ─────────────────────────────────────────────────────────────
    def tick(self) -> None:
        """Move all unfinished players one step (with MOVE_PROB probability)."""
        for player in self.players.values():
            if player.finished:
                continue
            if random.random() > MOVE_PROB:
                continue  # pause this tick

            player.row -= 1

            # Rung traversal: automatically switch to connected track
            key = (player.row, player.col)
            if key in RUNG_MAP:
                player.col = RUNG_MAP[key]

            # Finish check
            if player.row <= FINISH_ROW:
                player.row = FINISH_ROW
                player.finished = True
                self.finish_counter += 1
                player.finish_rank = self.finish_counter

        if self.all_finished():
            self.state = 'finished'

    def all_finished(self) -> bool:
        return bool(self.players) and all(p.finished for p in self.players.values())

    def game_state(self) -> dict:
        return {'players': [p.to_dict() for p in self.players.values()]}

    def results(self) -> list[dict]:
        medals = ['🥇', '🥈', '🥉', '🏅', '🏅']
        ranked = sorted(
            self.players.values(),
            key=lambda p: p.finish_rank or 999
        )
        return [
            {
                'rank':     i + 1,
                'pid':      p.pid,
                'nickname': p.nickname,
                'color':    p.color,
                'finished': p.finished,
                'medal':    medals[i] if i < len(medals) else '🏅',
            }
            for i, p in enumerate(ranked)
        ]


# ── Room Registry ──────────────────────────────────────────────────────────────
ROOMS: dict[str, LadderRoom] = {}


def make_room_code() -> str:
    while True:
        code = ''.join(random.choices(string.ascii_uppercase, k=4))
        if code not in ROOMS:
            return code
