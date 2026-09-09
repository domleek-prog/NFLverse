# NFL matchups — phase 1

Projects player stat lines from a player's own role and efficiency against
what the opposing defence gives up to his position.

## Running it

```
npm i -g netlify-cli
netlify dev
```

Deploy by pushing to a Git repo and connecting it in Netlify. No environment
variables. `netlify.toml` pins Node 20, which the function needs for global
`fetch`.

## Data

`netlify/functions/data.js` pulls weekly player stats and the schedule from the
[nflverse data releases](https://github.com/nflverse/nflverse-data/releases).
nflverse has renamed these files before, so the function tries several known
URL patterns per dataset and reports which one answered in the `sources` field.

The raw season file carries about 150 columns for every player on a roster,
including linemen and specialists. That is far too large to return through a
Lambda, so the function trims to the offensive skill positions and the ~20
columns the model uses before responding.

Cadence fits the weekly rhythm: Monday night finishes early Tuesday UK time,
nflverse updates overnight, so a Tuesday pull gets a complete week. Responses
cache for three hours.

## The projection

Every stat splits into **volume** and **efficiency**:

```
rush yards = carries x yards per carry
receiving  = targets x yards per target
passing    = attempts x yards per attempt
```

This split is the point. A defence has a large effect on how far a carry goes
and very little on how many carries a player gets — that is decided by his
role and the game script. Applying a single defensive multiplier to total
yards conflates the two and implies that a stout run defence takes carries
away from him, which is not how football works.

So the projection applies the matchup asymmetrically: efficiency takes the
defensive factor at full weight, volume takes it at 25%.

Both the player's rates and the defence's allowed rates are shrunk toward the
league average in proportion to how few games sit behind them. Prior-season
games are weighted at half, since defences turn over between years more than
offences do.

## What the numbers mean

- **Projection** — the headline line, in yards
- **Matchup edge** — how far the opponent moved the number, as a percentage
- **before matchup** — the player's own rates, so you can see what the
  opponent actually changed
- **thin** — fewer than three games behind the player or the defence

## Verified

Tested against a simulated league with known player roles, true yards per
carry, and true defensive strengths:

- fitted defensive efficiency factors correlate 0.93 with the true values
- projected volume stays stable across a soft and a stout matchup (11.6 vs
  11.8 carries) while efficiency does the moving, which is the design intent
- the soft/stout yardage ratio comes out at 1.28 against a true 1.50 — the
  attenuation is the shrinkage doing its job, not an error

## Known limits

- **Week 1 has no current-season data.** Projections lean entirely on last
  season, and defences change more than offences between years. This week's
  numbers are the least trustworthy of the season.
- **No game script.** The schedule carries `spread_line` and `total_line` but
  they are not yet used. A back on a team expected to trail gets fewer carries
  and more targets; right now the model does not know that.
- **No injury or depth chart awareness.** A committee back whose starter went
  down has recent stats that understate his new role, and the model will
  believe them.
- **No backtest.** Nothing here has been graded against what actually
  happened.

## Next

2. Game script from spread and total; usage projected from role rather than
   raw per-game averages
3. Snap share and depth charts, so role changes are picked up
4. Backtest against actual results, with calibration by projection band
5. Comparison against posted prop lines
