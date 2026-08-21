# Game Design Document (GDD): Nien Monster Chase - Mid-Autumn Event

## 1. Game Overview
* **Theme:** Mid-Autumn Festival (Sự kiện Trung Thu).
* **Genre:** Web-based Multiplayer, Casual, Co-op/Competitive.
* **Core Objective:** Players use firecrackers to scare the Nien monster (Niên thú), forcing it to drop Mid-Autumn gifts, and collect them to earn points.

## 2. Core Gameplay Mechanics

### 2.1. Map & Environment
* **Dynamic Scaling:** Map size scales proportionally with the total number of players (including Bots) in the room. (e.g., N players -> Grid size X by Y).
* **Perspective:** Top-down 2D for a broad, easy-to-manage view of the arena.

### 2.2. Loadout System (Pre-game Preparation)
Each player has a limited point pool (e.g., 100 points) to allocate into different stats before entering the match:
* **Movement Speed:** Move faster to chase the monster or collect dropped items.
* **Firecracker Range:** Ability to scare the monster from a further distance.
* **Firecracker Type:**
    * *Small Firecracker (Pháo tép):* Low point cost, slightly increases the Nien monster's "Fear Meter".
    * *Large Firecracker (Pháo cối):* High point cost, larger Area of Effect (AoE), significantly increases the "Fear Meter".

### 2.3. Nien Monster (Boss AI) Logic
* **Spawn:** Appears randomly on the map every 60 seconds.
* **Fear Meter:** Starts at 0. Increases whenever hit by firecrackers.
* **Behavior:** Runs in the opposite direction of the nearest firecracker explosion.
* **Drop Mechanic:** Drops gifts in a random radius when the Fear Meter reaches specific milestones (25%, 50%, 75%, 100%). At 100%, it disappears until the next spawn cycle.
* **Loot Limit:** The total amount of dropped loot per game is finite. The game ends when all loot is dropped.

### 2.4. Items & Scoring
Dropped items yield different score values. Players automatically collect them upon collision.
* *Star Lantern (Đèn ông sao):* 10 points.
* *Mooncake (Bánh trung thu):* 20 points.
* *Red Candle (Nến đỏ):* 5 points.

### 2.5. Bot System (AI Players)
* **Admin Configuration:** Administrators can set the exact number of bots before the game starts.
* **Bot Behavior:** Utilizes pathfinding algorithms (e.g., A*) to chase the Nien monster upon spawning, and prioritizes moving towards dropped items to collect them to simulate real player behavior.

## 3. Recommended System Architecture

* **Frontend (Client):** React, potentially combined with HTML5 Canvas API or a lightweight 2D library like PixiJS to render smooth gameplay graphics.
* **Backend (Server/API/Admin):** Laravel to handle the player database, authentication, admin configurations, and overall leaderboard management.
* **Real-time Engine:** A dedicated WebSocket server (e.g., Node.js + Socket.io, or Laravel Reverb) to synchronize player coordinates, monster states, and hitboxes at a high tick rate.
* **Cloud Infrastructure:** Azure (App Service, Database, and Web PubSub) to handle dynamic scaling during high-traffic event hours.

## 4. Implementation Phasing (Development Roadmap)

* **Phase 1 (MVP - Core Loop):** Static map layout, single-player movement, stationary Nien monster, basic firecracker throwing, and item dropping mechanics.
* **Phase 2 (Networking):** WebSocket integration, allowing multiple players to connect, see each other, and sync the monster's states and drops globally.
* **Phase 3 (Advanced Logic & Bots):** Implementation of the pre-game loadout allocation system, AI programming for bots, and dynamic evasion logic for the Nien monster.
* **Phase 4 (UI/UX & Polish):** Finalizing game assets (sprites, explosion effects), developing the leaderboard UI, and completing the Admin dashboard for event management.