extends Node
## Root script of the SoundManager autoload scene - an "autoload node".
## DTL Reader resolves SoundManager.tscn to this script for autocomplete.

## Master volume, from 0.0 (muted) to 1.0.
var volume: float = 1.0

## Plays a one-shot sound effect by name.
func play_sfx(sfx_name: String) -> void:
	pass

## Returns true while any music track is playing.
func is_music_playing() -> bool:
	return false
