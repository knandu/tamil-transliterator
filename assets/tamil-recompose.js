"use strict";
(() => {
  const independent = new Map([
    ["அ", ["a", "a"]], ["ஆ", ["A", "aa"]],
    ["இ", ["i", "i"]], ["ஈ", ["I", "ii"]],
    ["உ", ["u", "u"]], ["ஊ", ["U", "uu"]],
    ["எ", ["e", "e"]], ["ஏ", ["E", "ee"]],
    ["ஐ", ["ai", "ai"]], ["ஒ", ["o", "o"]],
    ["ஓ", ["O", "oo"]], ["ஔ", ["au", "au"]],
    ["ஃ", ["H", "h"]]
  ]);
  const consonants = new Map([
    ["க", ["k", "k"]], ["ங", ["ng", "ng"]],
    ["ச", ["ch", "ch"]], ["ஜ", ["j", "j"]],
    ["ஞ", ["nj", "nj"]], ["ட", ["T", "T"]],
    ["ண", ["N", "N"]], ["த", ["th", "th"]],
    ["ந", ["nh", "nh"]], ["ப", ["p", "p"]],
    ["ம", ["m", "m"]], ["ய", ["y", "y"]],
    ["ர", ["r", "r"]], ["ல", ["l", "l"]],
    ["வ", ["v", "v"]], ["ழ", ["Z", "zh"]],
    ["ள", ["L", "L"]], ["ற", ["R", "R"]],
    ["ன", ["n", "n"]], ["ஷ", ["sh", "sh"]],
    ["ஸ", ["s", "s"]], ["ஹ", ["h", "h"]],
    ["ஶ", ["sh", "sh"]]
  ]);
  const vowelSigns = new Map([
    ["ா", ["A", "aa"]], ["ி", ["i", "i"]],
    ["ீ", ["I", "ii"]], ["ு", ["u", "u"]],
    ["ூ", ["U", "uu"]], ["ெ", ["e", "e"]],
    ["ே", ["E", "ee"]], ["ை", ["ai", "ai"]],
    ["ொ", ["o", "o"]], ["ோ", ["O", "oo"]],
    ["ௌ", ["au", "au"]]
  ]);
  const virama = "்";

  function fromTamil(value) {
    const text = value.normalize("NFC");
    let compact = "", expanded = "", ambiguous = false;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      const vowel = independent.get(character);
      if (vowel) {
        compact += vowel[0]; expanded += vowel[1];
        continue;
      }
      const consonant = consonants.get(character);
      if (!consonant) {
        ambiguous = true;
        continue;
      }
      compact += consonant[0]; expanded += consonant[1];
      const next = text[index + 1];
      if (next === virama) {
        index += 1;
        continue;
      }
      const sign = vowelSigns.get(next);
      if (sign) {
        compact += sign[0]; expanded += sign[1];
        index += 1;
      } else {
        compact += "a"; expanded += "a";
      }
    }
    return { compact, expanded, ambiguous };
  }

  function expandCompact(value) {
    let expanded = "";
    for (const character of value) {
      expanded += ({
        A: "aa", I: "ii", U: "uu", E: "ee", O: "oo", Z: "zh"
      })[character] || character;
    }
    return expanded;
  }

  function isTamilWordCharacter(character) {
    if (!character) return false;
    const code = character.codePointAt(0);
    return code === 0x0B83 ||
      (code >= 0x0B85 && code <= 0x0BB9) ||
      (code >= 0x0BBE && code <= 0x0BCD) ||
      code === 0x0BD7;
  }

  window.TamilRecompose = Object.freeze({
    fromTamil,
    expandCompact,
    isTamilWordCharacter
  });
})();
