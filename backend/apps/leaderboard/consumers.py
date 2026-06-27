"""
Ladder Race v2 — Django Channels WebSocket Consumer
=====================================================
Handles: room creation, lobby, close_room, start-position selection,
         auto-movement game loop (80% move probability).
"""
import asyncio
import json

from channels.generic.websocket import AsyncWebsocketConsumer

from .ladder import (
    ROOMS, LadderRoom, RUNGS, NUM_COLS, NUM_ROWS,
    TICK_INTERVAL, SELECTION_TIME, MAX_PLAYERS,
    make_room_code,
)


def _map_payload() -> dict:
    return {'num_cols': NUM_COLS, 'num_rows': NUM_ROWS, 'rungs': RUNGS}


class LadderConsumer(AsyncWebsocketConsumer):

    # ── Lifecycle ──────────────────────────────────────────────────────────────
    async def connect(self) -> None:
        self.player_id: str | None = None
        self.room_code: str | None = None
        await self.accept()

    async def disconnect(self, close_code: int) -> None:
        if self.room_code and self.player_id:
            room = ROOMS.get(self.room_code)
            if room:
                room.remove_player(self.player_id)
                if not room.lobby:
                    if room.tick_task:
                        room.tick_task.cancel()
                    ROOMS.pop(self.room_code, None)
                else:
                    await self._broadcast('player_left_msg', {
                        'player_id': self.player_id,
                        'players':   room.lobby_list(),
                    })
        if self.room_code:
            await self.channel_layer.group_discard(self._grp(), self.channel_name)

    # ── Incoming router ────────────────────────────────────────────────────────
    async def receive(self, text_data: str) -> None:
        try:
            data = json.loads(text_data)
        except ValueError:
            return
        handlers = {
            'create_room':  self._create_room,
            'join_room':    self._join_room,
            'close_room':   self._close_room,
            'start_game':   self._start_game,
            'select_start': self._select_start,
        }
        handler = handlers.get(data.get('type', ''))
        if handler:
            await handler(data)

    # ── Message handlers ───────────────────────────────────────────────────────
    async def _create_room(self, data: dict) -> None:
        nickname = str(data.get('nickname', 'Player'))[:20]
        code = make_room_code()
        self.room_code = code
        self.player_id = 'p1'

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
        if len(room.lobby) >= MAX_PLAYERS:
            return await self._send({'type': 'error',
                                     'message': f'房間已滿（最多 {MAX_PLAYERS} 人）'})

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

    async def _close_room(self, data: dict) -> None:
        """Host closes the room; all players are kicked back to menu."""
        room = ROOMS.get(self.room_code)
        if not room or self.player_id != room.host_id:
            return
        if room.tick_task:
            room.tick_task.cancel()
        await self._broadcast('room_closed_msg', {'message': '主機已關閉房間'})
        ROOMS.pop(self.room_code, None)

    async def _start_game(self, data: dict) -> None:
        room = ROOMS.get(self.room_code)
        if not room or self.player_id != room.host_id or room.state != 'lobby':
            return
        if len(room.lobby) < 2:
            return await self._send({'type': 'error', 'message': '至少需要 2 位玩家'})

        room.state = 'selecting'
        await self._broadcast('selecting_msg', {
            'countdown': SELECTION_TIME,
            'map':       _map_payload(),
        })
        asyncio.ensure_future(self._selection_countdown(self.room_code))

    async def _select_start(self, data: dict) -> None:
        room = ROOMS.get(self.room_code)
        if not room or room.state != 'selecting':
            return
        try:
            col = int(data.get('col', -1))
        except (ValueError, TypeError):
            return
        if not room.select_col(self.player_id, col):
            return await self._send({'type': 'error', 'message': '此位置已被選'})
        await self._broadcast('start_selected_msg', {
            'player_id':     self.player_id,
            'col':           col,
            'selected_cols': room.selected_cols,
        })

    # ── Selection countdown → game launch ──────────────────────────────────────
    async def _selection_countdown(self, room_code: str) -> None:
        await asyncio.sleep(SELECTION_TIME)
        room = ROOMS.get(room_code)
        if not room or room.state != 'selecting':
            return

        room.auto_assign()
        room.build_players()
        room.state = 'playing'

        await self._broadcast('game_started_msg', {
            'state':         room.game_state(),
            'selected_cols': room.selected_cols,
            'map':           _map_payload(),
        })

        room.tick_task = asyncio.ensure_future(
            _game_loop(room_code, self.channel_layer)
        )

    # ── Channel-layer event receivers ──────────────────────────────────────────
    async def player_left_msg(self, event: dict) -> None:
        await self._send({'type': 'player_left',
                          'player_id': event['player_id'],
                          'players':   event['players']})

    async def player_joined_msg(self, event: dict) -> None:
        if event.get('player_id') != self.player_id:
            await self._send({'type': 'player_joined', 'players': event['players']})

    async def selecting_msg(self, event: dict) -> None:
        await self._send({'type': 'selecting',
                          'countdown': event['countdown'],
                          'map':       event['map']})

    async def start_selected_msg(self, event: dict) -> None:
        await self._send({'type': 'start_selected',
                          'player_id':     event['player_id'],
                          'col':           event['col'],
                          'selected_cols': event['selected_cols']})

    async def game_started_msg(self, event: dict) -> None:
        await self._send({'type': 'game_started',
                          'state':         event['state'],
                          'selected_cols': event['selected_cols'],
                          'map':           event['map']})

    async def tick_msg(self, event: dict) -> None:
        await self._send({'type': 'tick', 'state': event['state']})

    async def game_over_msg(self, event: dict) -> None:
        await self._send({'type': 'game_over', 'results': event['results']})

    async def room_closed_msg(self, event: dict) -> None:
        await self._send({'type': 'room_closed', 'message': event['message']})

    # ── Utility ────────────────────────────────────────────────────────────────
    def _grp(self) -> str:
        return f'ladder_{self.room_code}'

    async def _send(self, data: dict) -> None:
        await self.send(json.dumps(data, default=list))

    async def _broadcast(self, event_type: str, payload: dict) -> None:
        await self.channel_layer.group_send(
            self._grp(), {'type': event_type, **payload}
        )


# ── Standalone game loop ────────────────────────────────────────────────────────
async def _game_loop(room_code: str, channel_layer) -> None:
    """Runs detached from any consumer; ticks room and broadcasts state."""
    while True:
        await asyncio.sleep(TICK_INTERVAL)
        room = ROOMS.get(room_code)
        if not room or room.state != 'playing':
            break

        room.tick()

        await channel_layer.group_send(
            f'ladder_{room_code}',
            {'type': 'tick_msg', 'state': room.game_state()}
        )

        if room.state == 'finished':
            await channel_layer.group_send(
                f'ladder_{room_code}',
                {'type': 'game_over_msg', 'results': room.results()}
            )
            break
