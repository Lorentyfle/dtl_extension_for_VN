@tool
extends DialogicEvent

## A fake custom Dialogic event (it does nothing - there is no Dialogic in
## this test room): DTL Reader reads its shortcode, parameters and their
## documentation to suggest and document [screen_shake ...] in timelines.

### Settings

## How strong the shake is.
@export var strength: float = 1.0
## Whether to wait for the shake to end before continuing.
@export var wait := false
## How the screen moves.
@export var mode := "soft"


func _init() -> void:
	event_name = "Screen Shake"
	event_description = "Shakes the whole screen for a moment."
	event_category = "Visuals"


func get_shortcode() -> String:
	return "screen_shake"


func get_shortcode_parameters() -> Dictionary:
	return {
		"strength" : {"property": "strength", "default": 1.0},
		"wait" : {"property": "wait", "default": false},
		"mode" : {"property": "mode", "default": "soft", "suggestions": func(): return {"Soft": {"value": "soft"}, "Hard": {"value": "hard"}}},
	}
