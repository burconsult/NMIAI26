# Operations

## Main Components

- `run.py` executes one complete round.
- `watch.py` polls for active rounds and launches `run.py` when needed.
- `client.py` handles authenticated API communication.

## Retained Data

The repository keeps only the data that is useful for reproducing or validating the production configuration.

- `historical_model_cache.json` stores the cached empirical prior.
- `observations/` stores canonical per-seed observation artifacts.

## Runtime State

Repository cleanliness is maintained by keeping transient runtime artifacts outside the tracked tree.

- watcher state: `$HOME/Library/Application Support/ainm/astar/watcher_state.json`
- watcher logs: `$HOME/Library/Logs/ainm/astar/`

The local `.gitignore` in this challenge excludes transient files such as logs, bytecode, and temporary state.

## Automation Notes

The watcher is designed to be safe for long-running use.

- It checks the current round through the API before starting work.
- It refuses to overlap with an already-started round.
- It can recover its state from completed API submissions if the local process restarts.
- It runs with bytecode generation disabled to avoid writing runtime noise into the repository.

## Manual Commands

- `python3 astar/run.py`
- `python3 astar/watch.py --once`
- `python3 astar/watch.py --interval 15`

## Expected Environment

Set `NMIAI_ACCESS_TOKEN` in the environment, or place it in the repository root `.env` file used by `client.py`.
