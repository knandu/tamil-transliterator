"use strict";

function getTextareaCaret(textarea, caret) {
  // A textarea cannot contain popup DOM. Mirroring its text preserves wrapping and font metrics.
  const style = getComputedStyle(textarea), bounds = textarea.getBoundingClientRect();
  const mirror = document.createElement("div"), marker = document.createElement("span");
  for (const name of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
    "letterSpacing", "wordSpacing", "textIndent", "textAlign", "textTransform", "direction",
    "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]) {
    mirror.style[name] = style[name];
  }
  mirror.style.cssText += ";position:fixed;left:0;top:0;visibility:hidden;box-sizing:border-box;border-style:solid";
  mirror.style.width = `${textarea.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
  mirror.style.whiteSpace = textarea.wrap === "off" ? "pre" : "pre-wrap";
  mirror.style.overflowWrap = textarea.wrap === "off" ? "normal" : "break-word";
  mirror.textContent = textarea.value.slice(0, caret);
  marker.textContent = textarea.value.slice(caret) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const point = marker.getClientRects()[0], origin = mirror.getBoundingClientRect();
  const position = {
    left: bounds.left + point.left - origin.left - textarea.scrollLeft,
    top: bounds.top + point.top - origin.top - textarea.scrollTop,
    height: point.height,
    lineHeight: parseFloat(style.lineHeight) || point.height,
    bounds
  };
  mirror.remove();
  return position;
}
