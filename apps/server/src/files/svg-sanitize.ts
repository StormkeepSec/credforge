import { DOMImplementation, DOMParser, type Element, XMLSerializer } from '@xmldom/xmldom';

/**
 * Cleans an uploaded SVG (design plan §5.4, §12). The SVG is parsed as XML and rebuilt from an
 * allowlist: only static SVG drawing elements and presentation attributes survive. Removed:
 * scripts, event handlers, `foreignObject`, animation (which can rewrite links), links, metadata,
 * editor namespaces, processing instructions, and every reference outside the file (`href`s are
 * fragment-only, `url()` only `#id`; embedded raster images only as PNG/JPEG/GIF/WebP data URIs).
 * Documents with a DTD internal subset (entity definitions) are refused outright.
 *
 * The result is also served with a sandbox CSP and `nosniff`, and is normally shown with `<img>`,
 * where scripts never run; this is the first of those layers, not the only one.
 */

export class SvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgError';
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'pattern',
  'clipPath',
  'mask',
  'marker',
  'image',
  'style',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
]);

/** Kept as a plain group: their children are drawing, the element itself isn't. */
const UNWRAP = new Set(['a', 'switch']);

/** Elements whose text content is kept. */
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textPath', 'title', 'desc', 'style']);

const ATTRIBUTES = new Set(
  `id class style transform x y x1 y1 x2 y2 cx cy r rx ry fx fy fr width height d points pathLength
  viewBox preserveAspectRatio version baseProfile
  fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit
  stroke-dasharray stroke-dashoffset stroke-opacity opacity clip-path clip-rule mask filter color
  color-interpolation color-interpolation-filters color-rendering display visibility overflow
  font-family font-size font-size-adjust font-style font-weight font-variant font-stretch font
  letter-spacing word-spacing text-anchor dominant-baseline alignment-baseline baseline-shift
  text-decoration writing-mode direction unicode-bidi lengthAdjust textLength dx dy rotate
  startOffset method spacing side gradientUnits gradientTransform spreadMethod offset stop-color
  stop-opacity patternUnits patternContentUnits patternTransform clipPathUnits maskUnits
  maskContentUnits markerWidth markerHeight markerUnits refX refY orient marker-start marker-mid
  marker-end filterUnits primitiveUnits in in2 result stdDeviation mode type values operator k1 k2
  k3 k4 scale xChannelSelector yChannelSelector radius baseFrequency numOctaves seed stitchTiles
  flood-color flood-opacity lighting-color surfaceScale diffuseConstant specularConstant
  specularExponent kernelUnitLength azimuth elevation pointsAtX pointsAtY pointsAtZ
  limitingConeAngle tableValues slope intercept amplitude exponent order kernelMatrix divisor bias
  targetX targetY edgeMode preserveAlpha image-rendering shape-rendering text-rendering
  vector-effect paint-order mix-blend-mode isolation`.split(/\s+/),
);

/** Elements whose `href` may point at another element in the same file. */
const HREF_ELEMENTS = new Set([
  'use',
  'textPath',
  'linearGradient',
  'radialGradient',
  'pattern',
  'filter',
  'image',
  'feImage',
]);

const LOCAL_FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/\s]+=*$/;

const URL_FUNCTION = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** True when every `url(…)` in the value points at an element in this file. */
function onlyLocalUrls(value: string): boolean {
  // CSS escapes could spell `url(` in a way the checks below don't see.
  if (value.includes('\\')) return false;
  for (const match of value.matchAll(URL_FUNCTION)) {
    if (!LOCAL_FRAGMENT.test((match[2] ?? '').trim())) return false;
  }
  // Anything else that loads a resource, or a `url(` the pattern above didn't recognize.
  return !/(?:url|src|image-set|image|cross-fade|element)\s*\(/i.test(
    value.replace(URL_FUNCTION, ''),
  );
}

/**
 * CSS from a `style` attribute or element, without comments, or null when it could load
 * something or run script: imports, fonts, external URLs, escapes, legacy script hooks.
 */
function cleanCss(css: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (
    /\/\*|@import|@font-face|@namespace|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|<\//i.test(
      stripped,
    )
  ) {
    return null;
  }
  return onlyLocalUrls(stripped) ? stripped : null;
}

function safeAttributeValue(value: string): boolean {
  if (/javascript:|vbscript:|data:/i.test(value)) return false;
  return onlyLocalUrls(value);
}

/** Removes a doctype without an internal subset; refuses one with entity definitions. */
function stripDoctype(svg: string): string {
  const match = /<!DOCTYPE[^>[]*(\[)?/i.exec(svg);
  if (!match) return svg;
  if (match[1]) {
    throw new SvgError(
      'The SVG defines XML entities, which aren’t allowed. Export it again as plain SVG.',
    );
  }
  const end = svg.indexOf('>', match.index);
  return svg.slice(0, match.index) + svg.slice(end + 1);
}

export interface SanitizedSvg {
  svg: string;
  /** Elements and attributes that were removed, for logs and tests. */
  removed: string[];
}

export function sanitizeSvg(input: string): SanitizedSvg {
  const removed: string[] = [];
  const source = stripDoctype(input.replace(/^\uFEFF/, ''));
  if (/<!ENTITY/i.test(source)) {
    throw new SvgError(
      'The SVG defines XML entities, which aren’t allowed. Export it again as plain SVG.',
    );
  }

  let parsed: ReturnType<DOMParser['parseFromString']>;
  try {
    parsed = new DOMParser({
      onError(level, message) {
        if (level !== 'warning') throw new SvgError(`The SVG isn’t valid XML: ${message}`);
      },
    }).parseFromString(source, 'image/svg+xml');
  } catch (error) {
    // xmldom wraps what onError throws for fatal problems (unclosed tags) in its ParseError.
    if (error instanceof SvgError) throw error;
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof SvgError) throw cause;
    throw new SvgError('The SVG isn’t valid XML.');
  }
  const sourceRoot = parsed.documentElement;
  if (
    sourceRoot?.localName !== 'svg' ||
    (sourceRoot.namespaceURI !== SVG_NS && sourceRoot.namespaceURI !== null)
  ) {
    throw new SvgError('Not an SVG image: the root element must be <svg>.');
  }
  // A root without a namespace (hand-written SVG) is read as SVG; anything else must be SVG.
  const svgNamespace = sourceRoot.namespaceURI;

  const document = new DOMImplementation().createDocument(SVG_NS, 'svg', null);
  const root = document.documentElement;
  if (!root) throw new Error('Could not create the SVG document.');
  root.setAttributeNS(XMLNS_NS, 'xmlns:xlink', XLINK_NS);

  const copyAttributes = (from: Element, to: Element, name: string) => {
    for (const attribute of Array.from(from.attributes)) {
      const label = `${name}@${attribute.name}`;
      const value = attribute.value;
      if (attribute.namespaceURI === XMLNS_NS || attribute.name.startsWith('xmlns')) continue;
      if (attribute.namespaceURI === XML_NS) {
        if (attribute.localName === 'space' && (value === 'preserve' || value === 'default')) {
          to.setAttributeNS(XML_NS, 'xml:space', value);
        } else removed.push(label);
        continue;
      }
      const isHref =
        attribute.localName === 'href' &&
        (attribute.namespaceURI === XLINK_NS || attribute.namespaceURI === null);
      if (isHref) {
        const href = value.trim();
        const allowed =
          HREF_ELEMENTS.has(name) &&
          (LOCAL_FRAGMENT.test(href) || (name === 'image' && RASTER_DATA_URI.test(href)));
        if (allowed) to.setAttributeNS(XLINK_NS, 'xlink:href', href);
        else removed.push(label);
        continue;
      }
      if (attribute.namespaceURI !== null || !ATTRIBUTES.has(attribute.localName ?? '')) {
        removed.push(label);
        continue;
      }
      const clean =
        attribute.localName === 'style'
          ? cleanCss(value)
          : safeAttributeValue(value)
            ? value
            : null;
      if (clean !== null) to.setAttribute(attribute.localName as string, clean);
      else removed.push(label);
    }
  };

  const copyChildren = (from: Element, to: Element, name: string) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        // Text and CDATA: only inside text elements.
        if (TEXT_ELEMENTS.has(name)) {
          let text = child.nodeValue ?? '';
          if (name === 'style') {
            const css = cleanCss(text);
            if (css === null) {
              removed.push('style (unsafe CSS)');
              to.parentNode?.removeChild(to);
              return;
            }
            text = css;
          }
          to.appendChild(document.createTextNode(text));
        }
        continue;
      }
      if (child.nodeType !== 1) continue; // comments, processing instructions
      const element = child as Element;
      const local = element.localName ?? '';
      if (element.namespaceURI !== svgNamespace) {
        removed.push(element.nodeName);
        continue;
      }
      if (UNWRAP.has(local)) {
        removed.push(`${local} (kept its contents)`);
        const group = document.createElementNS(SVG_NS, 'g');
        to.appendChild(group);
        copyAttributes(element, group, 'g');
        copyChildren(element, group, 'g');
        continue;
      }
      if (!ELEMENTS.has(local)) {
        removed.push(local);
        continue;
      }
      if (local === 'image') {
        const href = element.getAttributeNS(XLINK_NS, 'href') ?? element.getAttribute('href') ?? '';
        if (!RASTER_DATA_URI.test(href.trim())) {
          removed.push('image (not an embedded PNG, JPEG, GIF or WebP)');
          continue;
        }
      }
      const copy = document.createElementNS(SVG_NS, local);
      to.appendChild(copy);
      copyAttributes(element, copy, local);
      copyChildren(element, copy, local);
    }
  };

  copyAttributes(sourceRoot, root, 'svg');
  copyChildren(sourceRoot, root, 'svg');

  if (
    !root.getAttribute('viewBox') &&
    !(root.getAttribute('width') && root.getAttribute('height'))
  ) {
    throw new SvgError('The SVG needs a viewBox, or a width and a height.');
  }

  const svg = new XMLSerializer().serializeToString(document);
  return { svg, removed };
}
