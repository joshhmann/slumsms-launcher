//! Game options: the [discord]/[clienthax] switches the client reads from config.ini at start-up.
//! A port of game-options.mjs.
//!
//! Pure text functions. The file is handled as latin1, one byte per character, so everything this
//! module does not own (comments, order, unknown sections and keys, CRLF, [config] host/port,
//! [debug], non-UTF-8 bytes) comes back byte-for-byte. Internally lines are kept as raw bytes.
//!
//! Reading follows the client's parser (inih in mapleroot/ijl15/INIReader.h): section and key names
//! are case-insensitive, `;`/`#` start a comment line, ` ;` starts an inline comment, a repeated key
//! (or an indented continuation line) joins values with a newline so the boolean no longer parses
//! and the client falls back to its default. Booleans are true/yes/on/1 and false/no/off/0.
//!
//! One key is read differently: slums.dll reads `doubletapjump` with Windows'
//! GetPrivateProfileStringA (src/bounce.cpp ReadIniBool), which takes the first `key=value` line of
//! the section and the whole rest of the line, so an inline comment makes the value unreadable.
//! Such options are marked `Reader::Profile`; their value is read that way and written without an
//! inline comment.

use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// How a movement key behaves when only MapleRoot's legacy `moveattack` is present.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Legacy {
    /// Defaults off whatever moveattack says.
    Walk,
    /// Defaults to moveattack.
    Follow,
}

/// Which of the client's two INI readers reads a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reader {
    /// MapleRoot's inih INIReader (mapleroot/ijl15/INIReader.h).
    Inih,
    /// Windows GetPrivateProfileStringA (src/bounce.cpp ReadIniBool).
    Profile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GameOption {
    pub id: &'static str,
    pub section: &'static str,
    pub key: &'static str,
    pub fallback: bool,
    pub group: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<Legacy>,
    pub reader: Reader,
    pub label: &'static str,
    pub description: &'static str,
}

#[allow(clippy::too_many_arguments)]
const fn option(id: &'static str, section: &'static str, key: &'static str, fallback: bool, group: &'static str, legacy: Option<Legacy>, label: &'static str, description: &'static str) -> GameOption {
    GameOption { id, section, key, fallback, group, legacy, reader: Reader::Inih, label, description }
}

const fn profile(option: GameOption) -> GameOption {
    GameOption { reader: Reader::Profile, ..option }
}

/// What the client does with each key, in player words. `fallback` is the client's value when the
/// key is absent (pinned to the client source by `fallbacks_match_the_client` below).
pub const GAME_OPTIONS: [GameOption; 10] = [
    option("discord", "discord", "enableactivitystatus", true, "General", None,
        "Show your game on Discord", "Shows your character's name, level and job as your Discord status while you play."),
    option("winkey", "clienthax", "enablewinkey", true, "General", None,
        "Allow the Windows key", "Keeps the Windows key working while the game window is active."),
    option("nobulb", "clienthax", "nobulb", true, "Display", None,
        "Hide the quest lightbulb", "Stops the lightbulb popping up when a new quest becomes available."),
    option("customcolor", "clienthax", "customcolor", true, "Display", None,
        "Orange name and skill text", "Shows your name and level in the stat window, and skill names, in orange."),
    option("attackwalk", "clienthax", "attackwalk", false, "Movement", Some(Legacy::Walk),
        "Keep walking while attacking", "Your character keeps sliding along the ground while an attack plays. Off: you stop to attack."),
    option("attackjump", "clienthax", "attackjump", true, "Movement", Some(Legacy::Follow),
        "Jump while attacking", "Lets you jump in the middle of an attack instead of waiting for it to finish."),
    option("chargemove", "clienthax", "chargemove", true, "Movement", Some(Legacy::Follow),
        "Move while charging skills", "Lets you move while holding a charged or key-down skill (like Hurricane or Big Bang)."),
    profile(option("doubletapjump", "clienthax", "doubletapjump", false, "Movement", None,
        "Double-tap jump to bounce", "Press jump again in mid-air to use your Ninja Bounce (air only). Off by default.")),
    option("jumpshoot", "clienthax", "jumpshoot", true, "Movement", None,
        "Shoot in mid-air", "Lets bow, crossbow, claw and gun attacks fire while you are jumping."),
    option("jumpmagic", "clienthax", "jumpmagic", true, "Movement", None,
        "Cast magic in mid-air", "Lets magic attacks be cast while you are jumping."),
];

/// MapleRoot's single switch for all three movement keys; read for older files, never written.
pub const LEGACY_MOVEATTACK: (&str, &str) = ("clienthax", "moveattack");

/// The three keys that replace MapleRoot's moveattack; a change to any of them writes all three.
pub const MOVE_ATTACK_IDS: [&str; 3] = ["attackwalk", "attackjump", "chargemove"];

/// UTF-8 BOM as raw bytes (latin1 "ï»¿").
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

pub fn option_by_id(id: &str) -> Option<&'static GameOption> {
    GAME_OPTIONS.iter().find(|option| option.id == id)
}

/// The client's value for every option when config.ini sets nothing.
pub fn default_values() -> BTreeMap<String, bool> {
    GAME_OPTIONS.iter().map(|option| (option.id.to_string(), option.fallback)).collect()
}

/// DEFAULT_VALUES as an ordered change list (GAME_OPTIONS order), for "Restore defaults".
pub fn default_changes() -> Vec<(String, bool)> {
    GAME_OPTIONS.iter().map(|option| (option.id.to_string(), option.fallback)).collect()
}

/// Bytes to a latin1 string (every byte one char) and back.
pub fn latin1_decode(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}
pub fn latin1_encode(text: &str) -> Vec<u8> {
    text.chars().map(|c| if (c as u32) <= 0xFF { c as u32 as u8 } else { b'?' }).collect()
}

/// Lower-case a latin1 byte string the way JavaScript's toLowerCase does for these characters.
fn lower(bytes: &[u8]) -> String {
    latin1_decode(bytes).to_lowercase()
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n' | 0x0B | 0x0C)
}
fn lskip(text: &[u8]) -> &[u8] {
    let start = text.iter().position(|c| !is_space(*c)).unwrap_or(text.len());
    &text[start..]
}
fn rstrip(text: &[u8]) -> &[u8] {
    let end = text.iter().rposition(|c| !is_space(*c)).map_or(0, |i| i + 1);
    &text[..end]
}

/// inih's find_chars_or_comment: index of the first of `chars`, or of a ';' that follows whitespace.
fn find_chars_or_comment(text: &[u8], chars: &[u8]) -> usize {
    let mut was_space = false;
    for (i, &c) in text.iter().enumerate() {
        if chars.contains(&c) || (was_space && c == b';') {
            return i;
        }
        was_space = is_space(c);
    }
    text.len()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Comment,
    Continuation,
    Section,
    Invalid,
    Blank,
    Key,
}

#[derive(Debug, Clone)]
pub struct Line {
    pub text: Vec<u8>,
    pub eol: Vec<u8>,
    pub kind: Kind,
    /// The section this line is in (for a section line: its own name).
    pub section: Vec<u8>,
    /// Key lines: the name as written.
    pub name: Vec<u8>,
    /// Key and continuation lines: the parsed value.
    pub value: Vec<u8>,
    /// Key lines: "section=name" lower-cased; continuation lines: the owning key's.
    pub key: String,
}

#[derive(Debug, Clone)]
pub struct Ini {
    pub bom: bool,
    pub eol: Vec<u8>,
    pub lines: Vec<Line>,
    /// 1-based number of the first line the client cannot parse, 0 when none.
    pub parse_error_line: usize,
}

/// Parse into lines, keeping each line's own terminator so joining them gives the input back exactly.
pub fn parse_ini(text: &[u8]) -> Ini {
    let bom = text.starts_with(BOM);
    let body = if bom { &text[BOM.len()..] } else { text };
    let mut lines = Vec::new();
    let mut at = 0;
    while at < body.len() {
        let end = body[at..].iter().position(|c| *c == b'\r' || *c == b'\n').map_or(body.len(), |i| at + i);
        let eol_len = if end >= body.len() { 0 } else if body[end] == b'\r' && body.get(end + 1) == Some(&b'\n') { 2 } else { 1 };
        lines.push(Line {
            text: body[at..end].to_vec(),
            eol: body[end..end + eol_len].to_vec(),
            kind: Kind::Blank,
            section: Vec::new(),
            name: Vec::new(),
            value: Vec::new(),
            key: String::new(),
        });
        at = end + eol_len;
    }
    let eol = lines.iter().find(|line| !line.eol.is_empty()).map_or_else(|| b"\r\n".to_vec(), |line| line.eol.clone());
    // Classify like inih.
    let mut section: Vec<u8> = Vec::new();
    let mut previous: Option<String> = None; // the key a continuation belongs to
    let mut error = 0;
    for (index, line) in lines.iter_mut().enumerate() {
        let raw = line.text.clone();
        let stripped = rstrip(&raw);
        let start = lskip(stripped);
        line.section = section.clone();
        if start.first() == Some(&b';') || start.first() == Some(&b'#') {
            line.kind = Kind::Comment;
            continue;
        }
        if let Some(owner) = &previous {
            if !start.is_empty() && start.len() < stripped.len() {
                line.kind = Kind::Continuation;
                line.key = owner.clone();
                let end = find_chars_or_comment(start, b"");
                line.value = rstrip(&start[..end]).to_vec();
                continue;
            }
        }
        if start.first() == Some(&b'[') {
            let end = find_chars_or_comment(&start[1..], b"]");
            if start.get(1 + end) == Some(&b']') {
                section = start[1..1 + end].to_vec();
                line.kind = Kind::Section;
                line.section = section.clone();
                previous = None;
            } else {
                line.kind = Kind::Invalid;
                if error == 0 {
                    error = index + 1;
                }
            }
            continue;
        }
        if start.is_empty() {
            line.kind = Kind::Blank;
            continue;
        }
        let end = find_chars_or_comment(start, b"=:");
        if matches!(start.get(end), Some(b'=') | Some(b':')) {
            line.kind = Kind::Key;
            line.name = rstrip(&start[..end]).to_vec();
            let value = lskip(&start[end + 1..]);
            line.value = rstrip(&value[..find_chars_or_comment(value, b"")]).to_vec();
            line.key = format!("{}={}", lower(&section), lower(&line.name));
            previous = Some(line.key.clone());
        } else {
            line.kind = Kind::Invalid;
            if error == 0 {
                error = index + 1;
            }
        }
    }
    Ini { bom, eol, lines, parse_error_line: error }
}

pub fn serialize_ini(ini: &Ini) -> Vec<u8> {
    let mut out = Vec::new();
    if ini.bom {
        out.extend_from_slice(BOM);
    }
    for line in &ini.lines {
        out.extend_from_slice(&line.text);
        out.extend_from_slice(&line.eol);
    }
    out
}

fn key_of(section: &str, key: &str) -> String {
    format!("{}={}", section.to_lowercase(), key.to_lowercase())
}

fn matches_key(line: &Line, wanted: &str) -> bool {
    matches!(line.kind, Kind::Key | Kind::Continuation) && line.key == wanted
}

/// The value the client sees for a key (repeats and continuations joined with "\n"), or None.
pub fn get_value(ini: &Ini, section: &str, key: &str) -> Option<Vec<u8>> {
    let wanted = key_of(section, key);
    let mut value: Option<Vec<u8>> = None;
    for line in ini.lines.iter().filter(|line| matches_key(line, &wanted)) {
        value = Some(match value {
            None => line.value.clone(),
            Some(v) if v.is_empty() => line.value.clone(),
            Some(mut v) => {
                v.push(b'\n');
                v.extend_from_slice(&line.value);
                v
            }
        });
    }
    value
}

/// What GetPrivateProfileStringA returns for a key: the first `key=value` line of the first matching
/// section (a ':' is not a separator), the rest of the line trimmed, one pair of surrounding quotes
/// removed, no inline comments. None when absent.
pub fn get_profile_value(ini: &Ini, section: &str, key: &str) -> Option<Vec<u8>> {
    profile_line(ini, section, key).map(|index| profile_value_of(&ini.lines[index]))
}

fn profile_line(ini: &Ini, section: &str, key: &str) -> Option<usize> {
    let wanted = key_of(section, key);
    ini.lines.iter().position(|line| line.kind == Kind::Key && line.key == wanted && profile_separator(line).is_some())
}

/// Index of the '=' that GetPrivateProfileString splits a key line at (the first '=' when no ':' comes before it).
fn profile_separator(line: &Line) -> Option<usize> {
    let at = line.text.iter().position(|c| *c == b'=' || *c == b':')?;
    (line.text[at] == b'=').then_some(at)
}

fn profile_value_of(line: &Line) -> Vec<u8> {
    let at = profile_separator(line).unwrap_or(line.text.len().saturating_sub(1));
    let value = rstrip(lskip(&line.text[(at + 1).min(line.text.len())..]));
    match value {
        [q, inner @ .., e] if (*q == b'"' || *q == b'\'') && q == e => inner.to_vec(),
        _ => value.to_vec(),
    }
}

/// The value the client's reader for `option` sees.
fn client_value(ini: &Ini, option: &GameOption) -> Option<Vec<u8>> {
    match option.reader {
        Reader::Inih => get_value(ini, option.section, option.key),
        Reader::Profile => get_profile_value(ini, option.section, option.key),
    }
}

/// inih GetBoolean without a default: Some(true), Some(false), or None when absent or unreadable.
pub fn parse_boolean(value: Option<&[u8]>) -> Option<bool> {
    let lowered = lower(value?);
    match lowered.as_str() {
        "true" | "yes" | "on" | "1" => Some(true),
        "false" | "no" | "off" | "0" => Some(false),
        _ => None,
    }
}

/// What the client will do with a config.ini.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameOptions {
    pub values: BTreeMap<String, bool>,
    pub legacy_move_attack: Option<bool>,
    pub parse_error_line: usize,
}

/// Movement keys follow the client's precedence (src/attackstop_patch.h ResolveMoveAttackSettings):
/// attackwalk defaults off whatever moveattack says; attackjump and chargemove default to moveattack.
pub fn read_ini_options(ini: &Ini) -> GameOptions {
    let legacy = parse_boolean(get_value(ini, LEGACY_MOVEATTACK.0, LEGACY_MOVEATTACK.1).as_deref());
    let mut values = BTreeMap::new();
    for option in &GAME_OPTIONS {
        let own = parse_boolean(client_value(ini, option).as_deref());
        let value = own.unwrap_or(if option.legacy == Some(Legacy::Follow) { legacy.unwrap_or(option.fallback) } else { option.fallback });
        values.insert(option.id.to_string(), value);
    }
    GameOptions { values, legacy_move_attack: legacy, parse_error_line: ini.parse_error_line }
}

pub fn read_game_options(text: &[u8]) -> GameOptions {
    read_ini_options(&parse_ini(text))
}

/// Keep the original key spelling, spacing and inline comment; replace only the value.
/// With `drop_comment` (GetPrivateProfileString keys) any inline comment goes, since that reader
/// would take it as part of the value.
fn rewrite_value(line: &Line, value: &[u8], drop_comment: bool) -> Vec<u8> {
    // /^(\s*[^=:]*?\s*[=:][ \t]*)(.*)$/s: everything up to the first '=' or ':' and the blanks after it.
    let Some(separator) = line.text.iter().position(|c| *c == b'=' || *c == b':') else {
        let mut out = line.name.clone();
        out.push(b'=');
        out.extend_from_slice(value);
        return out;
    };
    let mut split = separator + 1;
    while split < line.text.len() && matches!(line.text[split], b' ' | b'\t') {
        split += 1;
    }
    let (head, rest) = line.text.split_at(split);
    if drop_comment {
        if line.text[separator] != b'=' {
            let mut out = line.name.clone();
            out.push(b'=');
            out.extend_from_slice(value);
            return out;
        }
        let mut out = head.to_vec();
        out.extend_from_slice(value);
        return out;
    }
    let comment = find_chars_or_comment(rest, b"");
    let before = &rest[..comment];
    let trailing = before.len() - rstrip(before).len();
    let mut out = head.to_vec();
    out.extend_from_slice(value);
    out.extend_from_slice(&rest[comment - trailing..]);
    out
}

/// Set one option: the first line keeps its place, repeats and continuations go, a new key joins
/// the end of its section. A single line the client already reads as `on` is left byte-for-byte.
fn set_value(ini: &mut Ini, option: &GameOption, on: bool) {
    let (section, key) = (option.section, option.key);
    let wanted = key_of(section, key);
    let value: &[u8] = if on { b"true" } else { b"false" };
    let matches: Vec<usize> = ini.lines.iter().enumerate().filter(|(_, line)| matches_key(line, &wanted)).map(|(i, _)| i).collect();
    if matches.len() == 1 && ini.lines[matches[0]].kind == Kind::Key && parse_boolean(client_value(ini, option).as_deref()) == Some(on) {
        return;
    }
    let profile_first = if option.reader == Reader::Profile { profile_line(ini, section, key) } else { None };
    if let Some(&first) = matches.first() {
        // The first match is always a key line; for GetPrivateProfileString the line it reads is kept.
        let first = profile_first.unwrap_or(first);
        let rest: Vec<usize> = matches.iter().copied().filter(|&i| i != first).collect();
        let text = rewrite_value(&ini.lines[first], value, option.reader == Reader::Profile);
        ini.lines[first].text = text;
        ini.lines[first].value = value.to_vec();
        for &index in rest.iter().rev() {
            ini.lines.remove(index);
        }
        return;
    }
    let line = Line {
        text: format!("{key}={}", String::from_utf8_lossy(value)).into_bytes(),
        eol: ini.eol.clone(),
        kind: Kind::Key,
        section: section.as_bytes().to_vec(),
        name: key.as_bytes().to_vec(),
        value: value.to_vec(),
        key: wanted,
    };
    let wanted_section = section.to_lowercase();
    let header = ini.lines.iter().position(|entry| entry.kind == Kind::Section && lower(&entry.section) == wanted_section);
    if let Some(header) = header {
        // After the last key of the section's first block, else straight after its header.
        let mut at = header;
        let mut i = header + 1;
        while i < ini.lines.len() && ini.lines[i].kind != Kind::Section {
            if matches!(ini.lines[i].kind, Kind::Key | Kind::Continuation) {
                at = i;
            }
            i += 1;
        }
        if ini.lines[at].eol.is_empty() {
            ini.lines[at].eol = ini.eol.clone();
        }
        ini.lines.insert(at + 1, line);
        return;
    }
    let eol = ini.eol.clone();
    if let Some(last) = ini.lines.last_mut() {
        if last.eol.is_empty() {
            last.eol = eol.clone();
        }
        if last.kind != Kind::Blank {
            let section_of_last = last.section.clone();
            ini.lines.push(Line { text: Vec::new(), eol: eol.clone(), kind: Kind::Blank, section: section_of_last, name: Vec::new(), value: Vec::new(), key: String::new() });
        }
    }
    ini.lines.push(Line { text: format!("[{section}]").into_bytes(), eol, kind: Kind::Section, section: section.as_bytes().to_vec(), name: Vec::new(), value: Vec::new(), key: String::new() });
    ini.lines.push(line);
}

/// Apply ordered `(id, on)` changes to config.ini bytes and return the new bytes. Only the keys of
/// the changed options are touched, except that a change to one movement key writes all three (with
/// the values the client uses now, in MOVE_ATTACK_IDS order before the other changes), so the file no
/// longer depends on `moveattack`. `moveattack` itself is never written or removed.
pub fn apply_game_options<S: AsRef<str>>(text: &[u8], changes: &[(S, bool)]) -> Result<Vec<u8>> {
    let mut ini = parse_ini(text);
    let mut ordered: Vec<(String, bool)> = Vec::new();
    if changes.iter().any(|(id, _)| MOVE_ATTACK_IDS.contains(&id.as_ref())) {
        let current = read_ini_options(&ini).values;
        for id in MOVE_ATTACK_IDS {
            ordered.push((id.to_string(), current[id]));
        }
    }
    for (id, value) in changes {
        let id = id.as_ref();
        match ordered.iter_mut().find(|(existing, _)| existing == id) {
            Some(entry) => entry.1 = *value,
            None => ordered.push((id.to_string(), *value)),
        }
    }
    for (id, value) in &ordered {
        let option = option_by_id(id).ok_or_else(|| Error::new(format!("Unknown game option: {id}.")))?;
        set_value(&mut ini, option, *value);
    }
    Ok(serialize_ini(&ini))
}

/// Write every option explicitly: the value the client reads now (else its default), with `changes`
/// on top. After this the file no longer depends on any client default, so what the launcher shows
/// is what the game does whatever the client version. Lines the client already reads correctly are
/// left byte-for-byte; `moveattack`, [config], [debug] and unknown keys are never touched.
pub fn explicit_game_options(text: &[u8], changes: &BTreeMap<String, bool>) -> Result<Vec<u8>> {
    if let Some(unknown) = changes.keys().find(|id| option_by_id(id).is_none()) {
        return Err(Error::new(format!("Unknown game option: {unknown}.")));
    }
    let mut values = read_game_options(text).values;
    values.extend(changes.iter().map(|(id, on)| (id.clone(), *on)));
    apply_game_options_map(text, &values)
}

/// Apply a change map in GAME_OPTIONS order (maps carry no insertion order).
pub fn apply_game_options_map(text: &[u8], changes: &BTreeMap<String, bool>) -> Result<Vec<u8>> {
    if let Some(unknown) = changes.keys().find(|id| option_by_id(id).is_none()) {
        return Err(Error::new(format!("Unknown game option: {unknown}.")));
    }
    let ordered: Vec<(&str, bool)> = GAME_OPTIONS.iter().filter_map(|option| changes.get(option.id).map(|value| (option.id, *value))).collect();
    apply_game_options(text, &ordered)
}

/// Validate a change set from the page: known ids with boolean values only.
pub fn validate_changes(changes: &Value) -> Result<BTreeMap<String, bool>> {
    let object = changes.as_object().ok_or_else(|| Error::new("Game options must be an object."))?;
    let mut clean = BTreeMap::new();
    for (id, value) in object {
        if option_by_id(id).is_none() {
            return Err(Error::new(format!("Unknown game option: {id}.")));
        }
        let value = value.as_bool().ok_or_else(|| Error::new(format!("Game option {id} must be on or off.")))?;
        clean.insert(id.clone(), value);
    }
    Ok(clean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A JS string literal (latin1 characters) as file bytes.
    pub(crate) fn b(text: &str) -> Vec<u8> {
        latin1_encode(text)
    }

    /// A real player's config.ini (CRLF), plus things a player might add by hand.
    pub(crate) fn real() -> String {
        [
            "[general]", "resolution=5", "",
            "[discord]", "enableactivitystatus=true", "",
            "[clienthax]", "nobulb=true", "customcolor=true", "moveattack=true", "ChairOpacity=255", "SkillOpacity=255", "",
            "[config]", "host=203.0.113.7", "port=8484", "",
            "[debug]", "attackdiag=1", "",
        ]
        .join("\r\n")
    }

    fn apply(text: &str, changes: &[(&str, bool)]) -> String {
        latin1_decode(&apply_game_options(&b(text), changes).unwrap())
    }
    fn values(text: &str) -> BTreeMap<String, bool> {
        read_game_options(&b(text)).values
    }
    fn split_lines(text: &str) -> Vec<String> {
        text.replace("\r\n", "\n").split('\n').map(str::to_string).collect()
    }
    fn pick(values: &BTreeMap<String, bool>) -> [bool; 3] {
        [values["attackwalk"], values["attackjump"], values["chargemove"]]
    }

    #[test]
    fn parse_and_serialize_give_back_the_exact_text() {
        let samples = [
            real(),
            real().replace("\r\n", "\n"),
            "ï»¿; made by hand\r\n[clienthax]\r\nNoBulb = TRUE ; keep\r\n\r\n[mystery]\r\nfoo:bar\r\n# hash comment\r\n  indented continuation\r\nlast=1".to_string(),
            "a=1\rb=2\r".to_string(),
            String::new(),
            "\r\n\r\n".to_string(),
            "[config]\nhost=café.example\nport=8484".to_string(), // a latin1 byte survives as one character
        ];
        for text in samples {
            assert_eq!(serialize_ini(&parse_ini(&b(&text))), b(&text), "{text:?}");
        }
        // Raw non-UTF-8 bytes survive too.
        let raw = [b'a', b'=', 0xC7, 0xD1, b'\r', b'\n', 0xFF];
        assert_eq!(serialize_ini(&parse_ini(&raw)), raw);
    }

    #[test]
    fn reading_follows_the_client() {
        let v = values("[ClientHax]\r\nNoBulb = off ; I like the bulb\r\njumpshoot=maybe\r\n");
        assert!(!v["nobulb"]);
        assert!(v["jumpshoot"]); // unreadable -> client default
        assert!(v["discord"]); // absent -> client default
        assert!(!v["attackwalk"]);
        // A repeated key joins its values, which no longer parse: the client falls back to its default.
        assert!(values("[clienthax]\nnobulb=false\nnobulb=false\n")["nobulb"]);
        assert!(values("[clienthax]\nnobulb=false\n[clienthax]\nnobulb=false\n")["nobulb"]);
        assert_eq!(values(""), default_values());
    }

    #[test]
    fn an_unparseable_line_is_reported() {
        assert_eq!(read_game_options(&b(&real())).parse_error_line, 0);
        assert_eq!(read_game_options(&b("[clienthax]\r\nnobulb=true\r\njust some words\r\n")).parse_error_line, 3);
        assert_eq!(read_game_options(&b("[clienthax\r\n")).parse_error_line, 1);
    }

    #[test]
    fn editing_touches_only_the_owned_keys() {
        let real = real();
        let after = apply(&real, &[("nobulb", false), ("discord", false), ("customcolor", false)]);
        let before = split_lines(&real);
        let now = split_lines(&after);
        assert_eq!(now.len(), before.len());
        let changed: Vec<(String, String)> = before.iter().zip(&now).filter(|(a, b)| a != b).map(|(a, b)| (a.clone(), b.clone())).collect();
        assert_eq!(changed, vec![
            ("enableactivitystatus=true".to_string(), "enableactivitystatus=false".to_string()),
            ("nobulb=true".to_string(), "nobulb=false".to_string()),
            ("customcolor=true".to_string(), "customcolor=false".to_string()),
        ]);
        assert!(after.contains("[config]\r\nhost=203.0.113.7\r\nport=8484\r\n"));
        assert!(after.contains("[debug]\r\nattackdiag=1\r\n"));
        let bytes = after.as_bytes();
        assert!(bytes.iter().enumerate().all(|(i, c)| *c != b'\n' || (i > 0 && bytes[i - 1] == b'\r')), "every line ending stays CRLF");
        // Setting a value that is already there changes nothing.
        assert_eq!(apply(&real, &[("nobulb", true)]), real);
    }

    #[test]
    fn key_spelling_spacing_and_inline_comment_are_kept() {
        assert_eq!(apply("[ClientHax]\r\nNoBulb = TRUE ; was on\r\n", &[("nobulb", false)]), "[ClientHax]\r\nNoBulb = false ; was on\r\n");
    }

    #[test]
    fn missing_keys_and_sections_are_added_with_the_files_line_endings() {
        let added = apply(&real(), &[("doubletapjump", false), ("winkey", false)]);
        assert!(added.contains("SkillOpacity=255\r\ndoubletapjump=false\r\nenablewinkey=false\r\n\r\n[config]"), "{added}");
        let no_section = apply("[config]\nhost=x\nport=1", &[("nobulb", false), ("discord", false)]);
        assert_eq!(no_section, "[config]\nhost=x\nport=1\n\n[clienthax]\nnobulb=false\n\n[discord]\nenableactivitystatus=false\n");
        assert!(!values(&no_section)["nobulb"]);
    }

    #[test]
    fn repeats_and_continuations_of_an_edited_key_are_removed() {
        let after = apply("[clienthax]\nnobulb=false\ncustomcolor=true\nnobulb=false\n", &[("nobulb", false)]);
        assert_eq!(after, "[clienthax]\nnobulb=false\ncustomcolor=true\n");
        assert!(!values(&after)["nobulb"]);
        let continued = apply("[clienthax]\nnobulb=false\n  more\ncustomcolor=true\n", &[("nobulb", true)]);
        assert_eq!(continued, "[clienthax]\nnobulb=true\ncustomcolor=true\n");
    }

    #[test]
    fn legacy_moveattack() {
        let legacy_off = "[clienthax]\r\nmoveattack=false\r\n";
        assert_eq!(pick(&values(legacy_off)), [false, false, false]);
        assert_eq!(read_game_options(&b(legacy_off)).legacy_move_attack, Some(false));
        let legacy_on = "[clienthax]\r\nmoveattack=true\r\n";
        assert_eq!(pick(&values(legacy_on)), [false, true, true]);
        assert_eq!(pick(&values("")), [false, true, true]);
        assert_eq!(pick(&values("[clienthax]\nmoveattack=false\nattackjump=true\nattackwalk=on\n")), [true, true, false]);
        // Changing one movement key writes all three and leaves moveattack in place.
        let after = apply(legacy_off, &[("attackjump", true)]);
        assert_eq!(after, "[clienthax]\r\nmoveattack=false\r\nattackwalk=false\r\nattackjump=true\r\nchargemove=false\r\n");
        assert_eq!(pick(&values(&after)), [false, true, false]);
        // Restore defaults writes every owned key, never moveattack.
        let restored = latin1_decode(&apply_game_options(&b(legacy_off), &default_changes()).unwrap());
        assert_eq!(restored.matches("moveattack").count(), 1);
        assert_eq!(values(&restored), default_values());
        let restored_map = latin1_decode(&apply_game_options_map(&b(legacy_off), &default_values()).unwrap());
        assert_eq!(restored_map, restored);
    }

    #[test]
    fn double_tap_jump() {
        assert!(!values("")["doubletapjump"]);
        let after = apply(&real(), &[("doubletapjump", true)]);
        assert!(values(&after)["doubletapjump"]);
        assert!(!after.contains("attackwalk") && !after.contains("attackjump") && !after.contains("chargemove"), "an unrelated change does not add the movement keys");
        assert!(!values(&apply(&after, &[("doubletapjump", false)]))["doubletapjump"]);
        let option = option_by_id("doubletapjump").unwrap();
        assert!(!option.description.contains("Flash Jump") && !option.label.contains("Flash Jump"));
        assert_eq!(option.description, "Press jump again in mid-air to use your Ninja Bounce (air only). Off by default.");
    }

    /// Every fallback is the client's own default for that key (client line `client-1.5.0-fixes3`):
    /// - discord, winkey, nobulb, customcolor, jumpshoot, jumpmagic: mapleroot/ijl15/YourStuff.h
    ///   doini(), `reader.GetBoolean(section, key, "true")` (a non-null char* default, so true);
    /// - attackwalk / attackjump / chargemove: src/attackstop_patch.h ResolveMoveAttackSettings,
    ///   `attackWalk.value_or(false)`, `attackJump/chargeMove.value_or(legacy)` with legacy
    ///   `moveAttack.value_or(true)`;
    /// - doubletapjump: src/bounce.cpp `ReadIniBool("clienthax", "doubletapjump", false)` (false
    ///   since client 1.5.0), read with GetPrivateProfileStringA;
    /// - config.example.ini ships the same values (attackwalk=false, attackjump=true,
    ///   chargemove=true, doubletapjump=false, nobulb=true, customcolor=true, enableactivitystatus=true).
    /// Change this table only together with the client.
    #[test]
    fn fallbacks_match_the_client() {
        let client: [(&str, &str, &str, bool, Reader); 10] = [
            ("discord", "discord", "enableactivitystatus", true, Reader::Inih), // YourStuff.h
            ("winkey", "clienthax", "enablewinkey", true, Reader::Inih),        // YourStuff.h
            ("nobulb", "clienthax", "nobulb", true, Reader::Inih),              // YourStuff.h
            ("customcolor", "clienthax", "customcolor", true, Reader::Inih),    // YourStuff.h
            ("attackwalk", "clienthax", "attackwalk", false, Reader::Inih),     // attackstop_patch.h
            ("attackjump", "clienthax", "attackjump", true, Reader::Inih),      // attackstop_patch.h (moveattack default true)
            ("chargemove", "clienthax", "chargemove", true, Reader::Inih),      // attackstop_patch.h (moveattack default true)
            ("doubletapjump", "clienthax", "doubletapjump", false, Reader::Profile), // bounce.cpp
            ("jumpshoot", "clienthax", "jumpshoot", true, Reader::Inih),        // YourStuff.h
            ("jumpmagic", "clienthax", "jumpmagic", true, Reader::Inih),        // YourStuff.h
        ];
        assert_eq!(GAME_OPTIONS.len(), client.len());
        for (id, section, key, fallback, reader) in client {
            let option = option_by_id(id).unwrap_or_else(|| panic!("{id} missing"));
            assert_eq!((option.section, option.key, option.fallback, option.reader), (section, key, fallback, reader), "{id}");
            assert_eq!(values("")[id], fallback, "{id} with an empty config.ini");
        }
    }

    /// The page's copy (ui/game-options.mjs) must carry the same fallbacks and readers.
    #[test]
    fn the_page_table_matches() {
        let page = include_str!("../../ui/game-options.mjs");
        for option in &GAME_OPTIONS {
            let at = page.find(&format!("id: '{}',", option.id)).unwrap_or_else(|| panic!("{} not in the page table", option.id));
            let entry = &page[at..at + page[at..].find("},").unwrap()];
            assert!(entry.contains(&format!("fallback: {},", option.fallback)), "{}: {entry}", option.id);
            assert_eq!(entry.contains("reader: 'profile'"), option.reader == Reader::Profile, "{}", option.id);
            assert!(entry.contains(option.description.replace('\'', "\\'").as_str()), "{} description", option.id);
        }
    }

    #[test]
    fn double_tap_jump_is_read_like_get_private_profile_string() {
        // An inline comment is part of the value for this reader: unreadable, so the client default.
        assert!(!values("[clienthax]\r\ndoubletapjump=true ; on please\r\n")["doubletapjump"]);
        // The first line wins; a later repeat does not make it unreadable.
        assert!(values("[clienthax]\ndoubletapjump=true\ndoubletapjump=false\n")["doubletapjump"]);
        assert!(values("[clienthax]\ndoubletapjump = \"on\"\n")["doubletapjump"]);
        assert!(!values("[clienthax]\ndoubletapjump: true\n")["doubletapjump"]);
        // Writing drops the inline comment so the client can read the value.
        let on = apply("[clienthax]\r\ndoubletapjump=false ; off for now\r\nnobulb=true ; keep\r\n", &[("doubletapjump", true), ("nobulb", false)]);
        assert_eq!(on, "[clienthax]\r\ndoubletapjump=true\r\nnobulb=false ; keep\r\n");
        assert!(values(&on)["doubletapjump"]);
        assert_eq!(apply("[clienthax]\ndoubletapjump: false ; x\n", &[("doubletapjump", true)]), "[clienthax]\ndoubletapjump=true\n");
        // The line the client reads is the one kept.
        assert_eq!(apply("[clienthax]\ndoubletapjump: x\ndoubletapjump=off\n", &[("doubletapjump", true)]), "[clienthax]\ndoubletapjump=true\n");
    }

    #[test]
    fn every_option_is_written_explicitly_with_what_the_panel_shows() {
        let explicit = |text: &str, changes: &[(&str, bool)]| {
            let map: BTreeMap<String, bool> = changes.iter().map(|(k, v)| (k.to_string(), *v)).collect();
            latin1_decode(&explicit_game_options(&b(text), &map).unwrap())
        };
        let real = real();
        let shown = values(&real);
        let after = explicit(&real, &[]);
        // The client reads exactly what the panel showed, and every owned key is now in the file.
        assert_eq!(values(&after), shown);
        for option in &GAME_OPTIONS {
            assert!(get_value(&parse_ini(&b(&after)), option.section, option.key).is_some(), "{} written", option.id);
        }
        assert!(!after.contains("doubletapjump=true"));
        // Everything that was there stays byte-for-byte, in order; only new lines were added.
        let mut old = split_lines(&real).into_iter().peekable();
        for line in split_lines(&after) {
            if old.peek() == Some(&line) {
                old.next();
            }
        }
        assert_eq!(old.next(), None, "every original line survives in order");
        assert!(after.contains("[config]\r\nhost=203.0.113.7\r\nport=8484\r\n[debug]") || after.contains("[config]\r\nhost=203.0.113.7\r\nport=8484\r\n\r\n[debug]"));
        assert!(after.contains("[debug]\r\nattackdiag=1\r\n"));
        assert_eq!(after.matches("moveattack").count(), 1);
        assert!(after.as_bytes().iter().enumerate().all(|(i, c)| *c != b'\n' || (i > 0 && after.as_bytes()[i - 1] == b'\r')));
        // Doing it again changes nothing, and spellings the client already reads right are kept.
        assert_eq!(explicit(&after, &[]), after);
        let yes = "[clienthax]\r\nNoBulb = yes ; mine\r\n";
        assert!(explicit(yes, &[]).starts_with("[clienthax]\r\nNoBulb = yes ; mine\r\n"));
        // An unreadable value becomes the default the panel showed; changes go on top.
        let junk = explicit("[clienthax]\nnobulb=maybe\njumpshoot=false\n", &[("discord", false)]);
        let v = values(&junk);
        assert!(v["nobulb"] && !v["jumpshoot"] && !v["discord"] && !v["doubletapjump"]);
        assert!(junk.contains("nobulb=true\n"));
        // Legacy moveattack=false: the movement keys are written as the client reads them now.
        let legacy = explicit("[clienthax]\nmoveattack=false\n", &[]);
        assert_eq!(pick(&values(&legacy)), [false, false, false]);
        assert!(legacy.contains("attackjump=false") && legacy.contains("chargemove=false"));
        assert!(explicit_game_options(&b(&real), &BTreeMap::from([("host".to_string(), true)])).is_err());
    }

    #[test]
    fn only_known_options_with_on_off_values_are_accepted() {
        assert!(validate_changes(&json!({ "host": true })).unwrap_err().message.contains("Unknown game option"));
        assert!(validate_changes(&json!({ "nobulb": "false" })).unwrap_err().message.contains("on or off"));
        assert!(validate_changes(&json!([true])).unwrap_err().message.contains("must be an object"));
        assert!(apply_game_options(&b(&real()), &[("attackdiag", true)]).unwrap_err().message.contains("Unknown game option"));
        assert!(apply_game_options_map(&b(&real()), &BTreeMap::from([("attackdiag".to_string(), true)])).unwrap_err().message.contains("Unknown game option"));
        assert_eq!(validate_changes(&json!({ "nobulb": false })).unwrap(), BTreeMap::from([("nobulb".to_string(), false)]));
        assert!(GAME_OPTIONS.iter().all(|o| o.section != "config" && o.section != "debug" && o.key != "moveattack"));
    }

    #[test]
    fn option_table_serializes_for_the_page() {
        let value = serde_json::to_value(GAME_OPTIONS[4]).unwrap();
        assert_eq!(value["legacy"], "walk");
        assert_eq!(value["fallback"], false);
        assert!(serde_json::to_value(GAME_OPTIONS[0]).unwrap().get("legacy").is_none());
        assert_eq!(serde_json::to_value(GAME_OPTIONS[0]).unwrap()["reader"], "inih");
        assert_eq!(serde_json::to_value(option_by_id("doubletapjump").unwrap()).unwrap()["reader"], "profile");
    }
}
