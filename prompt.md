# The prompt

Fifth game in the harsh-critic-loop series (after
[NEONOID](https://github.com/melvincarvalho/neonoid),
[NEON MINER](https://github.com/melvincarvalho/neonminer),
[NEODROID](https://github.com/melvincarvalho/neodroid) and
[NEON DASH](https://github.com/melvincarvalho/neondash)). The new discipline:
a full turn-based roguelike — many coupled systems under one owner, and a
bot that has to pull off the entire heist before any critic sees a pixel.

```
Build a Sil-Q tribute at the level of a modern commercial roguelike remake.
Single-file browser game, zero assets. Original theme and names — the
Silmarillion belongs to Tolkien and Sil-Q to its authors; both are revered
here, neither is copied. You are SILQ, a thief in a dead neon arcology,
descending eight floors to pry the Prime Shard from the crown of the
sleeping machine-god VORL — and then climbing back out while the tower
wakes up and hunts you.

Authentic Sil mechanics, distilled: opposed-roll combat (1d10 + Melee vs
1d10 + Evasion, an extra damage die for every 5 points of net hit, damage
dice minus protection dice — every roll shown on screen); stealth as a
first-class playstyle (asleep / suspicious / hunting states, noise, and a
lamp whose radius is both your eyes and your signature); experience for
first sights and descent, not just kills, spent directly on four skills —
no character levels; a power clock that prices dawdling; and the inverted
second act — grabbing the shard is not the win, getting out with it is.

One owner writes the whole game. The harness must include a HEIST BOT:
a hazard-aware careful bot must complete the full heist — down, grab,
and out — on most seeds, and a reckless bot (lamp blazing, fights
everything) must die on most seeds, all headlessly with JSON telemetry
per run, before any critic sees a pixel. An unwinnable game is a build
failure, not a critique; so is an unlosable one.

Then /loop harsh sub-agent critics: the three visual lenses plus a SIL
FIDELITY critic who verifies the combat math from a deterministic
turn-by-turn capture strip — one fight, every die on screen, reconstructed
roll by roll — and the stealth model from an alert-state strip. Grade
against the commercial bar, call out fixes that didn't land, loop until
plateau, report the honest number.
```
