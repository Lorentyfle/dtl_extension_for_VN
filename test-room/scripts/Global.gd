extends Node
## Fake global script, only used to test DTL Reader's do/if/elif
## Global.member autocomplete and hover. Never meant to run.

## Current state of the (fake) game loop.
enum State { IDLE, TALKING, CHOOSING = 5, ENDED }

## Unnamed enums declare plain constants: Global.EASY, Global.HARD.
enum { EASY, HARD }

## Maximum number of hearts the player can have.
const MAX_HEARTS: int = 3
const GAME_TITLE = "DTL Reader Test Room" # "#" inside a string is not a comment

## Achievements unlocked so far, by id.
var unlocked_achievements: Array[String] = []
## Player's current number of hearts.
@export var hearts: int = MAX_HEARTS
var state := State.IDLE
var _secret_counter = 0 # "_"-prefixed: excluded from autocomplete/hover

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

## A function whose signature spans several lines.
func give_item(
	item_id: String,
	amount: int = 1,
) -> void:
	pass

# A plain "#" comment right above a function does NOT count as
# documentation - only "##" lines do.
func undocumented_function(a, b = [1, 2, 3]):
	return a

# Engine lifecycle callback - starts with "_", so it's excluded from
# autocomplete/hover, same as any other "_"-prefixed function.
func _ready() -> void:
	pass
