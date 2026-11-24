use encdr::LedValue;
use serde_json::{json, Value};
use std::collections::HashSet;

pub const DISPLAY_BUTTONS: [&str; 8] = [
    "top_1", "top_2", "top_3", "top_4", "top_5", "top_6", "top_7", "top_8",
];
const DEFAULT_BUTTON_COLOR: &str = "#393939";
const NOTE_EDIT_ACTIONS: [&str; 4] = ["accent", "slide", "octave_up", "octave_down"];

#[derive(Clone, Copy)]
pub struct Profile {
    pub product: u16,
    pub track: &'static str,
    pub pattern: &'static str,
    pub launcher: Option<&'static str>,
    pub clear: &'static str,
    pub octave_buttons: [&'static str; 2],
    pub dial: &'static str,
    pub knob_prefix: &'static str,
    pub indexed_buttons: bool,
}

impl Profile {
    pub fn for_name(name: &str) -> Option<Self> {
        let product = match name {
            "s49" => 0x1610,
            "s61" => 0x1620,
            "s88" => 0x1630,
            "maschine-mk3" => 0x1600,
            "maschine-plus" => 0x1820,
            _ => return None,
        };
        Self::for_product(product)
    }

    pub fn for_product(product: u16) -> Option<Self> {
        let komplete = match product {
            0x1610 | 0x1620 | 0x1630 => true,
            0x1600 | 0x1820 => false,
            _ => return None,
        };
        Some(Self {
            product,
            track: if komplete { "track" } else { "channel" },
            pattern: "pattern",
            launcher: match product {
                0x1610 => Some("key_mode"),
                0x1600 | 0x1820 => Some("arranger"),
                _ => None,
            },
            clear: if komplete { "clear" } else { "erase" },
            octave_buttons: if komplete {
                ["page_left", "page_right"]
            } else {
                ["arrow_left", "arrow_right"]
            },
            dial: if komplete {
                "encoder_main"
            } else {
                "main_encoder"
            },
            knob_prefix: if komplete {
                "encoder_"
            } else {
                "screen_encoder_"
            },
            indexed_buttons: komplete,
        })
    }

    pub fn buttons(self) -> impl Iterator<Item = &'static str> {
        [self.track, self.pattern, self.clear]
            .into_iter()
            .chain(self.launcher)
            .chain(self.octave_buttons)
            .chain(DISPLAY_BUTTONS)
    }

    pub fn lamp_buttons(self) -> impl Iterator<Item = &'static str> {
        self.buttons()
            .filter(move |name| {
                // Only the S49 MK2 descriptor has calibrated Komplete Kontrol page lamps.
                !self.indexed_buttons
                    || self.product == 0x1610
                    || !self.octave_buttons.contains(name)
            })
            .chain(
                (!self.indexed_buttons)
                    .then_some(self.dial_directions())
                    .into_iter()
                    .flatten(),
            )
    }

    pub fn dial_press(self) -> &'static str {
        if self.indexed_buttons {
            "encoder_main_press"
        } else {
            "encoder_press"
        }
    }

    pub fn dial_directions(self) -> [&'static str; 4] {
        if self.indexed_buttons {
            [
                "encoder_main_left",
                "encoder_main_right",
                "encoder_main_up",
                "encoder_main_down",
            ]
        } else {
            [
                "encoder_left",
                "encoder_right",
                "encoder_up",
                "encoder_down",
            ]
        }
    }

    pub fn lamp(self, name: &str, bright: bool) -> LedValue {
        if self.indexed_buttons && DISPLAY_BUTTONS.contains(&name) {
            LedValue::Single((17 << 2) | if bright { 3 } else { 0 })
        } else if bright {
            LedValue::Bright
        } else {
            LedValue::Dim
        }
    }
}

#[derive(Default)]
pub struct Controls {
    track_collapsed: bool,
    pressed: HashSet<&'static str>,
    pub clear_confirm: bool,
    pub launcher_active: bool,
    note_edit: Option<[bool; 4]>,
    track_setup: Option<(usize, u64)>,
}

impl Controls {
    pub fn mode(&self, profile: Profile) -> &'static str {
        if self.pressed.contains(profile.pattern) {
            "pattern"
        } else if !self.track_collapsed {
            "track"
        } else {
            "none"
        }
    }

    pub fn clear_held(&self, profile: Profile) -> bool {
        self.pressed.contains(profile.clear)
    }

    pub fn track_button_pressed(
        &mut self,
        slot: usize,
        active_slot: Option<usize>,
        page: u64,
    ) -> bool {
        self.track_setup = (active_slot == Some(slot)).then_some((slot, page));
        self.track_setup.is_some()
    }

    pub fn track_setup_page(&self) -> Option<u64> {
        self.track_setup.map(|(_, page)| page)
    }

    pub fn update_track_setup(
        &mut self,
        profile: Profile,
        page: u64,
        active_slot: Option<usize>,
    ) -> bool {
        let Some((slot, held_page)) = self.track_setup else {
            return false;
        };
        if self.launcher_active
            || self.note_edit.is_some()
            || self.clear_held(profile)
            || self.pressed.contains(profile.pattern)
            || held_page != page
            || active_slot != Some(slot)
        {
            self.track_setup = None;
            return true;
        }
        false
    }

    pub fn update_note_edit(&mut self, note: &Value) {
        self.note_edit = note.is_object().then(|| {
            let octave = note["canOctave"] == true;
            [
                note["canAccent"] == true,
                note["canSlide"] == true,
                octave,
                octave,
            ]
        });
    }

    pub fn display_button_colors<'a>(
        &self,
        profile: Profile,
        state: &'a Value,
    ) -> [Option<&'a str>; 8] {
        std::array::from_fn(|index| {
            if self.launcher_active {
                return None;
            }
            if index < 4 && (self.clear_held(profile) || self.note_edit.is_some()) {
                return None;
            }
            if self.clear_held(profile) && index >= 4 {
                return if self.clear_confirm {
                    [Some("#292929"), None, Some("#ff9890"), Some("#ff9890")][index - 4]
                } else {
                    Some(DEFAULT_BUTTON_COLOR)
                };
            }
            if let Some(available) = self.note_edit {
                return available[index - 4].then_some(DEFAULT_BUTTON_COLOR);
            }
            if self.pressed.contains(profile.pattern) {
                return Some(DEFAULT_BUTTON_COLOR);
            }
            let track = &state["slots"][index];
            Some(
                if !track["page"].is_null() && track["page"] == state["page"] {
                    track["color"].as_str().unwrap_or("#ff786e")
                } else {
                    DEFAULT_BUTTON_COLOR
                },
            )
        })
    }

    pub fn display_lamp(
        &self,
        profile: Profile,
        index: usize,
        color: Option<&str>,
        state: &Value,
        track_activity: u8,
    ) -> LedValue {
        let Some(color) = color else {
            return LedValue::Off;
        };
        let name = DISPLAY_BUTTONS[index];
        let mut bright = self.bright(profile, name);
        if !self.clear_held(profile) && self.note_edit.is_some() {
            bright |= match index {
                4 => state["noteEdit"]["accent"] == true,
                5 => state["noteEdit"]["slide"] == true,
                _ => false,
            };
            return profile.lamp(name, bright);
        }
        if self.pressed.contains(profile.pattern) && (index < 4 || !self.clear_held(profile)) {
            let level = state["patterns"][index]["level"].as_u64().unwrap_or(0);
            return match (profile.indexed_buttons, bright, level) {
                (true, true, _) | (true, false, 10..) => LedValue::Single(71),
                (true, false, 5..=9) => LedValue::Single(70),
                (true, false, 1..=4) => LedValue::Single(69),
                (_, false, 0) => LedValue::Off,
                (false, true, _) | (false, false, 10..) => LedValue::Bright,
                (false, false, _) => LedValue::Dim,
            };
        }
        let page = state["slots"][index]["page"].as_u64();
        let gate_flash = !bright
            && !self.clear_held(profile)
            && page
                .filter(|page| (1..=8).contains(page))
                .is_some_and(|page| track_activity & (1 << (page - 1)) != 0);
        if profile.product != 0x1610 {
            return if gate_flash {
                LedValue::single_percent(37)
            } else {
                profile.lamp(name, bright)
            };
        }
        let value = color
            .strip_prefix('#')
            .and_then(|hex| u32::from_str_radix(hex, 16).ok());
        let Some(value) = value else {
            return profile.lamp(name, bright);
        };
        let (r, g, b) = ((value >> 16) as u8, (value >> 8) as u8, value as u8);
        let floor = r.min(g).min(b);
        // Preserve the screen's hue when mapping pastel colors to NI's saturated palette.
        let neutral = r.max(g).max(b) - floor < 8;
        let hue = if neutral {
            17 << 2
        } else {
            LedValue::to_ni_palette_byte(r - floor, g - floor, b - floor) & !3
        };
        let idle_level = u8::from(!neutral);
        let level = if bright {
            3
        } else {
            idle_level + u8::from(gate_flash)
        };
        LedValue::Single(hue | level)
    }

    pub fn button(&mut self, profile: Profile, name: &'static str, pressed: bool) -> Option<Value> {
        let changed = if pressed {
            self.pressed.insert(name)
        } else {
            self.pressed.remove(name)
        };
        if !changed {
            return None;
        }
        if profile.launcher == Some(name) {
            self.track_setup = None;
            return Some(json!({ "kind": "pattern_launcher", "pressed": pressed }));
        }
        if !pressed {
            if self
                .track_setup
                .is_some_and(|(slot, _)| name == DISPLAY_BUTTONS[slot - 1])
            {
                self.track_setup = None;
            }
            if name == profile.clear {
                self.clear_confirm = false;
            }
            return None;
        }
        if name == profile.clear || name == profile.pattern {
            self.track_setup = None;
        }
        if self.launcher_active {
            return None;
        }
        if name == profile.track {
            self.track_collapsed = !self.track_collapsed;
            self.clear_confirm = false;
            return None;
        }
        if let Some(index) = profile
            .dial_directions()
            .iter()
            .position(|button| *button == name)
        {
            let direction = ["left", "right", "up", "down"][index];
            return (index < 2 || !self.pressed.contains(profile.dial_press()))
                .then(|| json!({ "kind": "nudge", "nudge": direction }));
        }
        if let Some(index) = profile
            .octave_buttons
            .iter()
            .position(|button| *button == name)
        {
            let transpose_octave = if index == 0 { -1 } else { 1 };
            return Some(json!({ "kind": "octave", "transposeOctave": transpose_octave }));
        }
        let index = DISPLAY_BUTTONS.iter().position(|button| *button == name)?;
        if index < 4 && (self.clear_held(profile) || self.note_edit.is_some()) {
            return None;
        }
        if self.clear_held(profile) && index >= 4 {
            let action = if self.clear_confirm {
                self.clear_confirm = false;
                match index {
                    6 => "clear_bar",
                    7 => "clear_pattern",
                    _ => return None,
                }
            } else {
                match index {
                    4 => "copy_bar",
                    5 => "copy_pattern",
                    6 => "paste",
                    7 => {
                        self.clear_confirm = true;
                        return None;
                    }
                    _ => return None,
                }
            };
            return Some(json!({ "kind": "edit", "action": action }));
        }
        if let Some(available) = self.note_edit {
            return available[index - 4]
                .then(|| json!({ "kind": "note_edit", "action": NOTE_EDIT_ACTIONS[index - 4] }));
        }
        self.clear_confirm = false;
        let slot = index + 1;
        if self.pressed.contains(profile.pattern) {
            Some(json!({ "kind": "pattern", "pattern": slot }))
        } else {
            Some(json!({ "kind": "slot", "slot": slot }))
        }
    }

    pub fn dial_turn(&self, delta: i32) -> Option<Value> {
        (!self.launcher_active && delta != 0).then(|| json!({ "kind": "dial", "dial": delta }))
    }

    pub fn bright(&self, profile: Profile, name: &str) -> bool {
        self.pressed.contains(name) || (name == profile.track && !self.track_collapsed)
    }

    pub fn lamp(&self, profile: Profile, name: &str) -> LedValue {
        if (self.launcher_active && profile.launcher != Some(name))
            || (self.clear_held(profile) && self.clear_confirm && name == "top_6")
        {
            LedValue::Off
        } else {
            profile.lamp(name, self.bright(profile, name))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dial_turn_scrolls_without_pressing_and_direction_presses_nudge_notes() {
        for controller in ["s49", "s61", "s88", "maschine-mk3", "maschine-plus"] {
            let profile = Profile::for_name(controller).unwrap();
            let mut controls = Controls::default();
            for delta in [-2, 1] {
                assert_eq!(
                    controls.dial_turn(delta),
                    Some(json!({ "kind": "dial", "dial": delta }))
                );
            }
            assert!(controls.dial_turn(0).is_none());
            for (button, direction) in profile
                .dial_directions()
                .into_iter()
                .zip(["left", "right", "up", "down"])
            {
                assert_eq!(
                    controls.button(profile, button, true),
                    Some(json!({ "kind": "nudge", "nudge": direction }))
                );
                assert!(controls.button(profile, button, true).is_none());
                assert!(controls.button(profile, button, false).is_none());
            }

            let press = profile.dial_press();
            assert!(controls.button(profile, press, true).is_none());
            for (button, direction) in profile.dial_directions()[..2].iter().zip(["left", "right"])
            {
                assert_eq!(
                    controls.button(profile, button, true),
                    Some(json!({ "kind": "nudge", "nudge": direction }))
                );
                assert!(controls.button(profile, button, false).is_none());
            }
            let up = profile.dial_directions()[2];
            assert!(controls.button(profile, up, true).is_none());
            assert!(controls.button(profile, up, false).is_none());
            let scroll = Some(json!({ "kind": "dial", "dial": 1 }));
            assert_eq!(controls.dial_turn(1), scroll);
            assert!(controls.button(profile, press, false).is_none());
            controls.launcher_active = true;
            assert!(controls.dial_turn(1).is_none());
            controls.launcher_active = false;
            assert_eq!(controls.dial_turn(1), scroll);
        }
    }

    #[test]
    fn track_setup_is_only_active_while_the_selected_slot_is_held() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls::default();
        controls.button(profile, "top_5", true);
        assert!(controls.track_button_pressed(5, Some(5), 2));
        assert_eq!(controls.track_setup_page(), Some(2));
        assert!(!controls.update_track_setup(profile, 2, Some(5)));
        controls.button(profile, "top_5", false);
        assert_eq!(controls.track_setup_page(), None);

        controls.button(profile, "top_6", true);
        assert!(!controls.track_button_pressed(6, Some(5), 2));
        assert!(!controls.update_track_setup(profile, 3, Some(6)));
        assert_eq!(controls.track_setup_page(), None);
        controls.button(profile, "top_6", false);

        controls.button(profile, "top_6", true);
        assert!(controls.track_button_pressed(6, Some(6), 3));
        assert!(controls.update_track_setup(profile, 2, Some(5)));
        assert_eq!(controls.track_setup_page(), None);
    }

    #[test]
    fn track_starts_active_and_can_be_toggled() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls::default();
        assert_eq!(controls.mode(profile), "track");
        assert_eq!(controls.lamp(profile, "track"), LedValue::Bright);
        assert_eq!(controls.lamp(profile, "top_2"), LedValue::Single(68));
        assert_eq!(controls.button(profile, "top_2", true).unwrap()["slot"], 2);
        assert_eq!(controls.lamp(profile, "top_2"), LedValue::Single(71));
        controls.button(profile, "top_2", false);
        assert_eq!(controls.lamp(profile, "top_2"), LedValue::Single(68));
        controls.button(profile, "track", true);
        controls.button(profile, "track", false);
        assert_eq!(controls.mode(profile), "none");
        assert_eq!(controls.lamp(profile, "track"), LedValue::Dim);
        controls.button(profile, "track", true);
        controls.button(profile, "track", false);
        assert_eq!(controls.mode(profile), "track");
    }

    #[test]
    fn pattern_is_momentary_and_returns_to_the_latched_track_strip() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls::default();
        controls.button(profile, "pattern", true);
        assert_eq!(controls.mode(profile), "pattern");
        controls.button(profile, "pattern", false);
        assert_eq!(controls.mode(profile), "track");
        controls.button(profile, "track", true);
        controls.button(profile, "track", false);
        controls.button(profile, "pattern", true);
        assert_eq!(controls.mode(profile), "pattern");
        assert!(controls.bright(profile, "pattern"));
        assert_eq!(
            controls.button(profile, "top_8", true).unwrap()["pattern"],
            8
        );
        controls.button(profile, "top_8", false);
        controls.button(profile, "pattern", false);
        assert_eq!(controls.mode(profile), "none");
        assert!(!controls.bright(profile, "pattern"));
        assert_eq!(controls.button(profile, "top_8", true).unwrap()["slot"], 8);
    }

    #[test]
    fn launcher_buttons_send_edges_without_switching_selectors() {
        for (controller, button) in [
            ("s49", "key_mode"),
            ("maschine-mk3", "arranger"),
            ("maschine-plus", "arranger"),
        ] {
            let profile = Profile::for_name(controller).unwrap();
            let mut controls = Controls::default();
            assert!(profile.buttons().any(|name| name == button));
            assert!(profile.lamp_buttons().any(|name| name == button));
            assert_eq!(controls.lamp(profile, button), LedValue::Dim);
            assert_eq!(
                controls.button(profile, button, true),
                Some(json!({ "kind": "pattern_launcher", "pressed": true }))
            );
            assert_eq!(controls.lamp(profile, button), LedValue::Bright);
            assert!(controls.button(profile, button, true).is_none());
            assert_eq!(controls.mode(profile), "track");
            controls.launcher_active = true;
            assert_eq!(
                controls.button(profile, button, false),
                Some(json!({ "kind": "pattern_launcher", "pressed": false }))
            );
            assert!(controls.button(profile, button, false).is_none());
        }
    }

    #[test]
    fn display_lamps_use_track_colors_and_white_pattern_levels() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls::default();
        let state = json!({ "page": 2, "slots": [{ "page": 2, "color": "#ff786e" }],
            "patterns": [{ "level": 12 }, { "level": 6 }, { "level": 4 }, { "level": 0 }] });
        let track_colors = controls.display_button_colors(profile, &state);
        assert_eq!(&track_colors[..2], &[Some("#ff786e"), Some("#393939")]);
        let track = controls.display_lamp(profile, 0, track_colors[0], &state, 0);
        assert_eq!(track, LedValue::Single(5));
        controls.button(profile, "pattern", true);
        let patterns = controls.display_button_colors(profile, &state);
        assert_eq!(
            [0, 1, 2, 3].map(|index| controls.display_lamp(
                profile,
                index,
                patterns[index],
                &state,
                0
            )),
            [
                LedValue::Single(71),
                LedValue::Single(70),
                LedValue::Single(69),
                LedValue::Off
            ]
        );
        controls.button(profile, "top_3", true);
        assert_eq!(
            controls.display_lamp(profile, 2, patterns[2], &state, 0),
            LedValue::Single(71)
        );
        let maschine = Profile::for_name("maschine-mk3").unwrap();
        assert_eq!(
            controls.display_lamp(maschine, 1, patterns[1], &state, 0),
            LedValue::Dim
        );
    }

    #[test]
    fn track_gate_flashes_are_dim_and_scoped_to_track_buttons() {
        let profile = Profile::for_name("s49").unwrap();
        let maschine = Profile::for_name("maschine-mk3").unwrap();
        let state = json!({
            "page": 1,
            "slots": [
                { "page": 1, "color": "#ff786e" },
                { "page": 2 }
            ],
            "patterns": [{}, { "level": 4 }]
        });
        let mut controls = Controls::default();
        let color = Some(DEFAULT_BUTTON_COLOR);
        assert_eq!(
            controls.display_lamp(profile, 1, color, &state, 0b10),
            LedValue::Single(69)
        );
        assert_eq!(
            controls.display_lamp(maschine, 1, color, &state, 0b10),
            LedValue::single_percent(37)
        );
        controls.button(profile, "top_2", true);
        assert_eq!(
            controls.display_lamp(profile, 1, color, &state, 0b10),
            LedValue::Single(71)
        );
        controls.button(profile, "top_2", false);
        controls.button(profile, "pattern", true);
        assert_eq!(
            controls.display_lamp(maschine, 1, color, &state, 0b10),
            LedValue::Dim
        );
    }

    #[test]
    fn launcher_disables_track_controls_but_key_mode_can_still_exit() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls {
            launcher_active: true,
            ..Controls::default()
        };
        for button in ["top_2", "track", "pattern", "clear", "page_left"] {
            assert!(controls.button(profile, button, true).is_none());
            assert_eq!(controls.lamp(profile, button), LedValue::Off);
            assert!(controls.button(profile, button, false).is_none());
        }
        assert_eq!(
            controls.button(profile, "key_mode", true).unwrap()["kind"],
            "pattern_launcher"
        );
        controls.launcher_active = false;
        assert_eq!(controls.button(profile, "top_2", true).unwrap()["slot"], 2);
    }

    #[test]
    fn page_arrows_send_one_octave_change_per_press() {
        for (controller, left, right) in [
            ("s49", "page_left", "page_right"),
            ("maschine-mk3", "arrow_left", "arrow_right"),
        ] {
            let profile = Profile::for_name(controller).unwrap();
            let mut controls = Controls::default();
            assert!(profile.buttons().any(|name| name == left));
            assert!(profile.lamp_buttons().any(|name| name == right));
            assert_eq!(controls.lamp(profile, left), LedValue::Dim);
            assert_eq!(
                controls.button(profile, left, true).unwrap()["transposeOctave"],
                -1
            );
            assert_eq!(controls.lamp(profile, left), LedValue::Bright);
            assert!(controls.button(profile, left, true).is_none());
            assert!(controls.button(profile, left, false).is_none());
            assert_eq!(
                controls.button(profile, right, true).unwrap()["transposeOctave"],
                1
            );
        }
    }

    #[test]
    fn clear_is_momentary_and_scopes_edits_to_the_right_display() {
        let profile = Profile::for_name("maschine-mk3").unwrap();
        let mut controls = Controls::default();
        controls.button(profile, "pattern", true);
        controls.button(profile, "erase", true);
        assert!(controls.bright(profile, "erase"));
        assert!(controls.button(profile, "top_2", true).is_none());
        assert_eq!(
            controls.display_button_colors(profile, &Value::Null)[1],
            None
        );
        assert_eq!(
            controls.button(profile, "top_5", true).unwrap()["action"],
            "copy_bar"
        );
        assert!(controls.button(profile, "top_8", true).is_none());
        assert!(controls.clear_confirm);
        controls.button(profile, "top_8", false);
        assert_eq!(
            controls.button(profile, "top_8", true).unwrap()["action"],
            "clear_pattern"
        );
        controls.button(profile, "erase", false);
        assert!(!controls.clear_held(profile));
        assert!(!controls.bright(profile, "erase"));
        assert_eq!(controls.mode(profile), "pattern");
        controls.button(profile, "top_8", false);
        assert_eq!(
            controls.button(profile, "top_8", true).unwrap()["pattern"],
            8
        );
    }

    #[test]
    fn note_edit_routes_only_the_right_display_buttons() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls::default();
        controls
            .update_note_edit(&json!({ "canAccent": true, "canSlide": true, "canOctave": true }));
        for button in &DISPLAY_BUTTONS[..4] {
            assert!(controls.button(profile, button, true).is_none());
        }
        for (button, action) in DISPLAY_BUTTONS[4..].iter().zip(NOTE_EDIT_ACTIONS) {
            assert_eq!(
                controls.button(profile, button, true),
                Some(json!({ "kind": "note_edit", "action": action }))
            );
            controls.button(profile, button, false);
        }
        controls.button(profile, "clear", true);
        assert_eq!(
            controls.button(profile, "top_5", true).unwrap()["action"],
            "copy_bar"
        );
        controls.button(profile, "top_5", false);
        controls.button(profile, "clear", false);
        controls.update_note_edit(&json!({ "canAccent": false, "canOctave": false }));
        assert!(controls.button(profile, "top_5", true).is_none());
        assert!(controls.button(profile, "top_6", true).is_none());
    }
}
