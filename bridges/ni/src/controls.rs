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
        let komplete = matches!(name, "s49" | "s61" | "s88");
        Some(Self {
            product,
            track: if komplete { "track" } else { "channel" },
            pattern: "pattern",
            launcher: (name == "s49").then_some("key_mode"),
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
                    .then_some(["encoder_up", "encoder_down"])
                    .into_iter()
                    .flatten(),
            )
    }

    pub fn dial_button(self, name: &str) -> Option<i32> {
        match (self.indexed_buttons, name) {
            (true, "encoder_main_up") | (false, "encoder_up") => Some(1),
            (true, "encoder_main_down") | (false, "encoder_down") => Some(-1),
            _ => None,
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
        if profile.product != 0x1610 {
            return profile.lamp(name, bright);
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
        LedValue::Single(
            hue | if bright {
                3
            } else if neutral {
                0
            } else {
                1
            },
        )
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
        if let Some(dial) = profile.dial_button(name) {
            return Some(json!({ "kind": "dial", "dial": dial }));
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
    fn key_mode_sends_launcher_edges_without_switching_selectors() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls::default();
        assert!(profile.lamp_buttons().any(|name| name == "key_mode"));
        assert_eq!(
            controls.button(profile, "key_mode", true),
            Some(json!({ "kind": "pattern_launcher", "pressed": true }))
        );
        assert!(controls.button(profile, "key_mode", true).is_none());
        assert_eq!(controls.mode(profile), "track");
        assert_eq!(
            controls.button(profile, "key_mode", false),
            Some(json!({ "kind": "pattern_launcher", "pressed": false }))
        );
        assert!(controls.button(profile, "key_mode", false).is_none());
    }

    #[test]
    fn display_lamps_use_track_colors_and_white_pattern_levels() {
        let profile = Profile::for_name("s49").unwrap();
        let mut controls = Controls::default();
        let state = json!({ "page": 2, "slots": [{ "page": 2, "color": "#ff786e" }],
            "patterns": [{ "level": 12 }, { "level": 6 }, { "level": 4 }, { "level": 0 }] });
        let track_colors = controls.display_button_colors(profile, &state);
        assert_eq!(&track_colors[..2], &[Some("#ff786e"), Some("#393939")]);
        let track = controls.display_lamp(profile, 0, track_colors[0], &state);
        assert_eq!(track, LedValue::Single(5));
        controls.button(profile, "pattern", true);
        let patterns = controls.display_button_colors(profile, &state);
        assert_eq!(
            [0, 1, 2, 3].map(|index| controls.display_lamp(
                profile,
                index,
                patterns[index],
                &state
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
            controls.display_lamp(profile, 2, patterns[2], &state),
            LedValue::Single(71)
        );
        let maschine = Profile::for_name("maschine-mk3").unwrap();
        assert_eq!(
            controls.display_lamp(maschine, 1, patterns[1], &state),
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
