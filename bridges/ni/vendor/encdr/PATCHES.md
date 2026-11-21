# Local changes — 2026-11-11

Source: RufusIbiza/Encdr, published encdr 0.8.5, commit `4e1fa75aa329fc18823be88e6a0c1b385f53f6ac`, repository path `encdr`. Upstream: https://github.com/RufusIbiza/Encdr. GPL-3.0-or-later as declared in Cargo.toml. LICENSE is the original repository license at that commit, also carried with the encdr-view patch. Source, descriptors and assets are retained with notices; registry packaging markers and the dependency's own lockfile are omitted.

Modified src/usb/device_thread.rs:

- DeviceHandle::disconnect/Drop no longer clear physical connectivity and ownership before requesting and joining output teardown.
- Input worker handles an explicit Disconnect as a graceful shutdown; it preserves flags until screen/LED workers finish. Physical USB read errors still mark the device disconnected immediately; ownership loss remains respected.
- finish_disconnect publishes disconnected state after worker joins. Regression tests assert flags are visible during output completion and genuinely unplugged/lost-control states are never restored.
- LED cleanup reports successful clear transfers or transfer errors instead of silently discarding write results.

Cause: published code set is_connected=false before the output workers reached their final cleanup guards, so they classified normal shutdown as physical unplug and skipped screen/LED output. User observed the test LEDs and pages remaining after exit. Normal shutdown should clear LEDs and replace the test graphics with Encdr's exit screensaver; this does not power down MK3 or guarantee LCD backlights turn off.

Modifications remain GPL-3.0-or-later. Preserve these notices and corresponding source on redistribution; a local app and corresponding source archive can be produced by scripts/package_local.py.

Reconnect increment, 2026-11-11:

- src/lib.rs: apply the configured supported_controllers filter to explicit scan as well as background hotplug. Both use descriptor_supported; regression test distinguishes MK3 17cc:1600 from Maschine+ 17cc:1820 and preserves the unfiltered case.
- src/usb/service_detector.rs: when ENCDR_FORCE_SERVICE is selected, the once-per-scan message explains keeping NI agents running rather than emitting the raw-USB termination advice. Generic claim-error diagnostics remain available for other routes.
- The application enables existing background hotplug and retargets screen views after connection changes. Source/provenance/license terms above are unchanged.

MK3 service frame recovery (11 November 2026): ScreenManager can request full keyframes for changes in the upper70% of the screen while retaining partial transfers for bottom values. Service MK3 enables this policy; MK3_ALLOW_PARTIAL disables it for A/B diagnostics. Unchanged frames are skipped even when partial blits are unavailable. Screen pipeline timings behind MK3_SCREEN_TIMING distinguish conversion and service time. One screen-manager lifecycle regression and actual NI transfer checks passed. Full frames cost about 30ms, small partials about4ms on this setup; policy deliberately preserves the latter for values. Physical reversal failure itself was not captured/reproduced; independent browser frames remove reliance on a retained incremental image.

Recovery hardening: src/usb/hid.rs retains one process-lifetime HID API manager on a dedicated owner thread for initialization, enumeration and opening. Handles retain their existing reader/writer behavior. A real 32-enumeration/four-caller regression verified a single live owner. This addresses an older HID/run-loop crash report; it does not prove the intermittent freeze eliminated.

S49 Mk2 native input (12 November 2026): ni_komplete_kontrol_s49_mk2.json routes report 0x01 and decodes eight 0–999 cyclic positions from byte pairs10/11 through24/25, based on the connected 17cc:1610 capture /tmp/mk3-komplete-live-corrected.log. Remove the incorrect51-byte/nibble knob decoder; MIDI-mode0xAA reports are not a second input source. Existing wrap1000 implementation is reused. Root controller tests replay an actual report plus direction/wrap/ownership cases. Full packet bytes are available only at TRACE log level for hardware diagnostics. No other keyboard descriptor is changed.

13 November 2026: user-isolated native report captures establish S49 Mk2 BROWSER at report0x01 byte5 mask0x04 and held SHIFT at byte6 mask0x04. Add only those input buttons; do not guess the BROWSER LED offset. Root parser regression checks both button edges and the existing preset/page mappings. Captures: g1-state/s49-browser-shift-capture-1794565428199050000.json in the integrating project.

13 November 2026 correction: the user identified byte6 mask0x04 as a dial event, not SHIFT. Removed the mistakenly added shift input; the earlier capture claim above is superseded. BROWSER byte5 mask0x04 remains. No guessed replacement SHIFT input. The integrating application's controller allowlist/native-mode gate now reserves native/DAW controls and pauses after detected SETUP/MIDI/INSTANCE until ownership returns.

13 November2026 requested opt-in pipeline trace: screen worker logs dequeued RGBA content hash, unchanged-frame suppression and successful host transfer completion/timing. Same hash algorithm as encdr-view capture identifies submitted contents. Trace is gated by MK3_TRACE_PIPELINE and MK3_TRACE_UNTIL_MS. Host/service completion is not physical LCD scanout acknowledgment.

13 November2026 diagnostic full-frame mode: MK3_S49_FULL_FRAMES opts S49 NI-service endpoints into full-only command descriptors; raw USB/other devices unchanged. Full-only screens suppress identical frames even at the periodic60-capture keyframe boundary, since every changed frame is already self-contained. Trace output includes full/bytes. Lifecycle regression verifies full bottom-value update and120 static frames skipped. The NI-service partial-update hypothesis remains unverified physically.

### S49 Mk2 LED semantic correction — 2026-11-16

User observed physical page `<` lighting TRACK and `>` lighting KEY MODE while Encdr owned the surface; raw input trace confirms byte3 masks80/20 were the page buttons. The unchanged upstream LED names at payload offsets23/28 are therefore wrong for this device. Rename offset23 to track and offset28 to key_mode. Remove unverified page_left/page_right output entries; do not invent replacement offsets. Keep report prefix/length and brightness encoding unchanged: no evidence of a global off-by-one or RGB layout. The bridge now uses PLUG-IN input byte5 mask02 (isolated physical capture) for Module Edit, with existing descriptor plugin lamp37; Top5 is unassigned/off. Remaining lamp locations/colors still require physical validation, including BROWSER and page arrows. Source comparison: https://github.com/RufusIbiza/Encdr/blob/main/encdr/descriptors/ni_komplete_kontrol_s49_mk2.json .

S49 ordered physical capture also establishes KEY MODE input report01 byte4 mask40. LED calibration exposes an explicit button_probe strip over the79-byte button payload, using existing Encdr strip semantics; only the opt-in capture-only diagnostic writes it. This is not a verified production lamp map.

### Final physically calibrated S49 LED correction — 2026-11-16

Supersedes provisional mapping notes above. User-isolated probes show SHIFT14,SCALE15,TRACK23,STOP31,LEFT32,RIGHT33,CLEAR34,BROWSER35,PLUGIN36,MIXER37. Display lamps are Indexed at2..9:158 produces green;71 white verified at display3 and8. Change all8 Single items to Indexed, using existing white dim69/bright71 conversion. Group order anchored at adjacent display2/3 and far-right8. No global offset or RGB triples inferred. Preset lamp entries removed rather than repurposed; their input mapping remains unchanged. Evidence ledger in project g1-state/s49-led-calibration-20261116.json; regression in src/controller.rs guards actual packet positions/encoding.

S49 Mk2 MIXER input added from isolated physical capture2026-11-16: report01 byte5 mask01. Lamp37 already calibratedwhite. BridgebindsMixerpage explicitly; no guessed input or MK3mapping.
