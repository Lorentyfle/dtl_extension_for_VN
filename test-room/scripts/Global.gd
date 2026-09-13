extends Node
## Fake global script, only used to test DTL Reader's do/if/elif
## Global.function_name(...) autocomplete and hover. Never meant to run.

var unlocked_achievements: Array[String] = []

## Checks whether the player has unlocked the given achievement.
## Returns true if unlocked, false otherwise.
func has_achievement(achievement_id: String) -> bool:
	return unlocked_achievements.has(achievement_id)

## Applies a color tint to the current speaker's portrait, defaulting to
## plain white (no tint) if no color is given.
func apply_tint(color: Color = Color(1, 1, 1, 1)) -> void:
	pass

## Returns a random greeting from a fixed list.
func random_greeting() -> String:
	return "Hello"

# A plain "#" comment right above a function does NOT count as
# documentation - only "##" lines do.
func undocumented_function(a, b = [1, 2, 3]):
	return a

# Engine lifecycle callback - starts with "_", so it's excluded from
# autocomplete/hover, same as any other "_"-prefixed function.
func _ready() -> void:
	pass
