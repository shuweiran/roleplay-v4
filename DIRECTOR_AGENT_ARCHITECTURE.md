# Director Agent architecture

## Why this exists

The previous “主控” path conflated three different jobs:

1. interpreting what the player meant;
2. converting that input into narration;
3. changing actual world/scheduler state.

Only (1) and (2) existed. The model could therefore say “鲸鱼已经离场” while `Router.agents` still contained 鲸鱼, so the scheduler continued to treat the character as present. Player Persona data was also sent by the frontend but discarded by the scene-start API, which made identity/relationship reasoning unstable.

The new design separates **language interpretation** from **authoritative state mutation**.

---

## Components

### 1. `DirectorAgent` — interpretation plane

File: `backend/core/director_agent.py`

Responsibilities:

- understand natural-language controller requests;
- keep a bounded recent controller conversation (60 messages);
- propose structured operations;
- explain current controller state to the player;
- never claim an operation succeeded before the state layer accepts it.

It is not allowed to:

- speak or decide for role characters;
- invent that a character entered/left;
- rewrite already-established events;
- treat “registered in cast” as “currently on stage”.

Structured operations:

- `set_stage(character, present)`
- `set_entry_order(order)`
- `set_relation(source, target, relation)`
- `add_scene_note(text)`

### 2. `DirectorSession` — authoritative controller memory

This is stable state, not LLM memory.

It stores:

- the player's exact role identity and Persona payload;
- full cast roster;
- relationships;
- entry order;
- `onstage` and `offstage` separately;
- scene constraints/notes;
- explicit pre-entry confirmation;
- bounded controller-chat history.

Important invariant:

> `cast != onstage`

A character can remain registered and keep its Persona while being absent from the current scene.

### 3. `/api/director/*` — execution plane

File: `backend/api/routes_director.py`

Endpoints:

- `POST /api/director/preflight`
- `GET /api/director/preflight/{id}`
- `POST /api/director/preflight/{id}/chat`
- `POST /api/director/chat`
- `GET /api/director/state`

The execution order is:

```text
player text
  -> DirectorAgent interprets intent
  -> structured operation
  -> DirectorSession validates/mutates
  -> runtime roster synchronizes
  -> verified result returned to player
```

The model cannot bypass the mutation/validation step.

### 4. Scene scheduler binding

File: `backend/api/routes_scenes.py`

When a confirmed preflight session starts a scene:

- the backend now reads the frontend's full `characters` JSON payload;
- the human player's full Persona is preserved instead of being replaced with `扮演{name}`;
- the `DirectorSession` is attached to the runtime Router;
- only `DirectorSession.onstage` characters remain in `Router.agents`;
- offstage NPC Personas remain in the durable registry;
- bringing an NPC back reconstructs the Agent from that original Persona.

This makes absence deterministic: an offstage character is not available to Arbiter and cannot be scheduled to speak.

---

## Pre-entry flow

For general narrative chat with a human-controlled role:

```text
role selection
  -> create Director preflight
  -> 主控 shows player identity / relationships / current cast state
  -> player discusses first-scene presence and entry order
  -> player explicitly confirms
  -> backend validates confirmed preflight_id
  -> real scene is created
  -> gameplay begins
```

The gate deliberately distinguishes:

- “让兔子进入场景” — a character stage operation;
- “确认进入场景” — permission to create/start the whole scene.

A character-entry sentence cannot accidentally unlock the game-start gate.

---

## Runtime controller flow

The gameplay UI exposes a separate `🎬 主控` panel. Controller commands are not mixed with in-character speech.

Example:

```text
玩家：先让鲸鱼离场
DirectorAgent -> { set_stage: 鲸鱼, present: false }
DirectorSession -> onstage removes 鲸鱼; offstage adds 鲸鱼
runtime sync -> Router.agents removes 鲸鱼
主控：已写入权威状态：鲸鱼离场
```

Later:

```text
玩家：现在谁在场？
主控 reads DirectorSession, not roster guesses / LLM recollection
=> 当前在场：未然、兔子；当前离场：鲸鱼
```

And:

```text
玩家：把鲸鱼拉进来
DirectorSession -> present=true
runtime sync -> rebuild Agent using stored whale Persona
=> only then return “鲸鱼进场”
```

---

## Memory model

Three tiers are intentionally separate:

1. **authoritative facts** — `DirectorSession`; never compressed into probabilistic prose;
2. **controller conversational context** — last 60 Director messages for pronouns/intention continuity;
3. **roleplay memory** — existing `MemoryStore`/compression for character conversations and narrative history.

After a verified controller mutation, a concise `【主控已验证状态】` marker is mirrored into roleplay memory so active role Agents share the same scene facts.

---

## Behavioral invariants

1. No “executed” wording before successful state mutation.
2. `onstage/offstage` is authoritative for scheduling.
3. Player identity comes from the actual selected `RoleCard`, not a generic placeholder.
4. Player identity cannot be silently removed from stage by a controller operation.
5. Registered cast does not imply current presence.
6. Re-entry restores the original full Persona.
7. Explicit player confirmation is mandatory before scene creation in the new preflight path.
8. Main role speech and controller commands use separate UI/API paths.

---

## Regression coverage

`backend/tests/test_director_agent.py` covers:

- full player identity retained;
- whale leaves while remaining in cast registry;
- subsequent “who is present?” still reports whale as offstage;
- whale can be brought back;
- player cannot be silently removed;
- controller chat history remains bounded;
- “character enters scene” is not mistaken for “player confirms game start”.
