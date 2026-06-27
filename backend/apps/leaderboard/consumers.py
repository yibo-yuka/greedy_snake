"""
Ladder Race — Django Channels WebSocket Consumer
=================================================
Handles: room creation, lobby, start-position selection,
         game loop coordination, and score persistence.
"""
import asyncio
import json
import time

from channels.generic.websocket import AsyncWebsocketConsumer

from .ladder import (
    ROOMS, LadderRoom, Snake, MAP_CELLS, VALID_START_COLS,
    FINISH_ROW, TICK_INTERVAL, SELECTION_TIME, GAME_TIME_LIMIT,
    make_room_code, _OPPOSITE,
)


# ── Helpers ───────────────────────────────────────────────────────────────
def _map_payload() -> list[list[int]]:
    """Serialise MAP_CELLS as [[col, row], ...] for JSON."""
    return [list(c) for c in MAP_CELLS]


# ── Consumer ──────────────────────────────────────────────────────────────
class LadderConsumer(AsyncWebsocketConsumer):

    # ── Lifecycle ─────────────────────────────────────────────────────────
    async def connect(self) -> None:
        self.player_id: str | None = None
        self.room_code: str | None = None
        await self.accept()

    async def disconnect(self, close_code: int) -> None:
        if self.room_code and self.player_id:
            room = ROOMS.get(self.room_code)
            if room:
                room.remove_player(self.player_id)
                still_here = len(room.lobby) + len(room.snakes)
                if still_here == 0:
                    if room.tick_task:
                        room.tick_task.cancel()
                    ROOMS.pop(self.room_code, None)
                else:
                    await self._broadcast('player_left_msg', {
                        'player_id': self.player_id,
                        'players':   room.lobby_list(),
                    })
        if self.room_code:
            await self.channel_layer.group_discard(
                self._grp(), self.channel_name
            )

    # ── Incoming router ───────────────────────────────────────────────────
    async def receive(self, text_data: str) -> None:
        try:
            data = json.loads(text_data)
        except ValueError:
            return
        t = data.get('type', '')
        handlers = {
            'create_room':  self._create_room,
            'join_room':    self._join_room,
            'start_game':   self._start_game,
            'select_start': self._select_start,
            'move':         self._move,
        }
        handler = handlers.get(t)
        if handler:
            await handler(data)

    # ── Message handlers ──────────────────────────────────────────────────
    async def _create_room(self, data: dict) -> None:
        nickname  = str(data.get('nickname', 'Player'))[:20]
        code      = make_room_code()
        self.room_code  = code
        self.player_id  = 'p1'

        room = LadderRoom(code, 'p1')
        room.add_lobby_player('p1', nickname)
        ROOMS[code] = room

        await self.channel_layer.group_add(self._grp(), self.channel_name)
        await self._send({
            'type':      'room_joined',
            'room_code': code,
            'player_id': 'p1',
            'players':   room.lobby_list(),
            'is_host':   True,
            'map':       _map_payload(),
        })

    async def _join_room(self, data: dict) -> None:
        code     = str(data.get('room_code', '')).upper().strip()
        nickname = str(data.get('nickname', 'Player'))[:20]
        room     = ROOMS.get(code)

        if not room:
            return await self._send({'type': 'error', 'message': '找不到房間'})
        if room.state != 'lobby':
            return await self._send({'type': 'error', 'message': '遊戲已開始，無法加入'})
        if len(room.lobby) >= 4:
            return await self._send({'type': 'error', 'message': '房間已滿（最多 4 人）'})

        self.room_code = code
        pid = f'p{len(room.lobby) + 1}'
        self.player_id = pid
        room.add_lobby_player(pid, nickname)

        await self.channel_layer.group_add(self._grp(), self.channel_name)
        await self._send({
            'type':      'room_joined',
            'room_code': code,
            'player_id': pid,
            'players':   room.lobby_list(),
            'is_host':   False,
            'map':       _map_payload(),
        })
        await self._broadcast('player_joined_msg', {
            'player_id': pid,
            'players':   room.lobby_list(),
        })

    async def _start_game(self, data: dict) -> None:
        room = ROOMS.get(self.room_code)
        if not room or self.player_id != room.host_id or room.state != 'lobby':
            return
        if len(room.lobby) < 2:
            return await self._send({'type': 'error', 'message': '至少需要 2 位玩家'})

        room.state = 'selecting'
        await self._broadcast('selecting_msg', {'countdown': SELECTION_TIME})
        asyncio.ensure_future(self._selection_countdown(self.room_code))

    async def _select_start(self, data: dict) -> None:
        room = ROOMS.get(self.room_code)
        if not room or room.state != 'selecting':
            return
        try:
            col = int(data.get('col', -1))
        except (ValueError, TypeError):
            return
        if col not in VALID_START_COLS:
            return
        taken = {v for k, v in room.selected_cols.items() if k != self.player_id}
        if col in taken:
            return await self._send({'type': 'error', 'message': '此起點已被選'})
        room.selected_cols[self.player_id] = col
        await self._broadcast('start_selected_msg', {
            'player_id':    self.player_id,
            'col':          col,
            'selected_cols': room.selected_cols,
        })

    async def _move(self, data: dict) -> None:
        room = ROOMS.get(self.room_code)
        if not room or room.state != 'playing':
            return
        snake = room.snakes.get(self.player_id)
        if not snake or snake.finished:
            return
        direction = data.get('direction', '')
        if direction in ('up', 'down', 'left', 'right'):
            if direction != _OPPOSITE.get(snake.direction):
                snake.pending = direction

    # ── Selection countdown → game launch ─────────────────────────────────
    async def _selection_countdown(self, room_code: str) -> None:
        await asyncio.sleep(SELECTION_TIME)
        room = ROOMS.get(room_code)
        if not room or room.state != 'selecting':
            return

        # Assign defaults to players who didn't select
        used: set[int] = set(room.selected_cols.values())
        for pid in room.lobby:
            if pid not in room.selected_cols:
                for col in VALID_START_COLS:
                    if col not in used:
                        room.selected_cols[pid] = col
                        used.add(col)
                        break

        # Build snakes
        for pid, info in room.lobby.items():
            col = room.selected_cols.get(pid, VALID_START_COLS[0])
            room.snakes[pid] = Snake(pid, info['nickname'], info['color'], col)

        room.spawn_apples()
        room.state      = 'playing'
        room.start_time = time.time()

        await self._broadcast('game_started_msg', {
            'state':         room.state_dict(),
            'selected_cols': room.selected_cols,
            'map':           _map_payload(),
        })

        room.tick_task = asyncio.ensure_future(
            _game_loop(room_code, self.channel_layer)
        )

    # ── Channel-layer event receivers ─────────────────────────────────────
    async def player_left_msg(self, event: dict) -> None:
        await self._send({'type': 'player_left',
                          'player_id': event['player_id'],
                          'players':   event['players']})

    async def player_joined_msg(self, event: dict) -> None:
        if event.get('player_id') != self.player_id:
            await self._send({'type': 'player_joined', 'players': event['players']})

    async def selecting_msg(self, event: dict) -> None:
        await self._send({'type': 'selecting', 'countdown': event['countdown']})

    async def start_selected_msg(self, event: dict) -> None:
        await self._send({'type': 'start_selected',
                          'player_id':    event['player_id'],
                          'col':          event['col'],
                          'selected_cols': event['selected_cols']})

    async def game_started_msg(self, event: dict) -> None:
        await self._send({'type': 'game_started',
                          'state':         event['state'],
                          'selected_cols': event['selected_cols'],
                          'map':           event['map']})

    async def tick_msg(self, event: dict) -> None:
        await self._send({'type': 'tick',
                          'state':   event['state'],
                          'elapsed': event['elapsed']})

    async def game_over_msg(self, event: dict) -> None:
        await self._send({'type': 'game_over', 'results': event['results']})

    # ── Utility ───────────────────────────────────────────────────────────
    def _grp(self) -> str:
        return f'ladder_{self.room_code}'

    async def _send(self, data: dict) -> None:
        await self.send(json.dumps(data, default=list))

    async def _broadcast(self, event_type: str, payload: dict) -> None:
        await self.channel_layer.group_send(
            self._grp(),
            {'type': event_type, **payload}
        )


# ── Standalone game loop (runs detached from any specific consumer) ────────
async def _game_loop(room_code: str, channel_layer) -> None:
    while True:
        await asyncio.sleep(TICK_INTERVAL)
        room = ROOMS.get(room_code)
        if not room or room.state != 'playing':
            break

        elapsed = time.time() - room.start_time

        # Tick all snakes
        for snake in room.snakes.values():
            if snake.finished:
                continue

            snake.direction = snake.pending
            nh = snake.next_head()

            if nh not in MAP_CELLS:
                continue  # wall — don't move, don't die

            apple_idx = room.apple_at(nh)
            grow = apple_idx >= 0
            snake.move(grow)

            if grow:
                snake.apples_eaten += 1
                room.respawn_apple(apple_idx)

            if snake.body[0][1] >= FINISH_ROW:
                snake.finished    = True
                snake.finish_time = time.time()

        # Broadcast tick
        await channel_layer.group_send(
            f'ladder_{room_code}',
            {'type': 'tick_msg', 'state': room.state_dict(), 'elapsed': elapsed}
        )

        # End conditions
        if room.all_finished() or elapsed >= GAME_TIME_LIMIT:
            room.state = 'finished'
            results    = room.results()

            try:
                await _persist_scores(results)
            except Exception:
                pass

            await channel_layer.group_send(
                f'ladder_{room_code}',
                {'type': 'game_over_msg', 'results': results}
            )
            break


async def _persist_scores(results: list[dict]) -> None:
    """Save apples_eaten → Score table for ladder mode."""
    from channels.db import database_sync_to_async
    from .models import GameMode, Score

    @database_sync_to_async
    def _save() -> None:
        try:
            mode = GameMode.objects.get(name='ladder')
            for r in results:
                if r['apples_eaten'] > 0:
                    Score.objects.create(
                        nickname     = r['nickname'],
                        mode         = mode,
                        score        = r['apples_eaten'] * 10,  # 1 apple = 10 pts
                        apples_eaten = r['apples_eaten'],
                        level_reached= None,
                    )
        except Exception:
            pass

    await _save()
