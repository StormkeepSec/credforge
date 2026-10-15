import { describe, expect, it } from 'vitest';
import { SvgError, sanitizeSvg } from '../src/files/svg-sanitize';

const wrap = (body: string, attributes = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"${attributes}>${body}</svg>`;

const clean = (body: string, attributes = '') => sanitizeSvg(wrap(body, attributes)).svg;

describe('sanitizeSvg', () => {
  it('keeps ordinary drawing', () => {
    const svg = clean(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
        '<g transform="rotate(10)"><path d="M0 0L10 10" fill="url(#g)" stroke="#000"/></g>' +
        '<use xlink:href="#g"/><text x="1" y="2" font-family="Arial">A &amp; B</text>',
    );
    expect(svg).toContain('fill="url(#g)"');
    expect(svg).toContain('xlink:href="#g"');
    expect(svg).toContain('A &amp; B');
    expect(svg).toContain('<path d="M0 0L10 10"');
  });

  it.each([
    ['script elements', '<script>alert(1)</script>', /script|alert/],
    ['script in CDATA', '<script><![CDATA[alert(1)]]></script>', /alert/],
    [
      'event handlers',
      '<rect width="1" height="1" onload="alert(1)" onclick="x()"/>',
      /onload|onclick/,
    ],
    [
      'foreignObject',
      '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>x</script></body></foreignObject>',
      /foreignObject|body|script/,
    ],
    [
      'javascript links',
      '<a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a>',
      /javascript|href/,
    ],
    [
      'animation that rewrites links',
      '<a><animate attributeName="href" values="javascript:alert(1)"/></a>',
      /animate|javascript/,
    ],
    ['set', '<set attributeName="onmouseover" to="alert(1)"/>', /<set|alert/],
    ['external use', '<use href="https://evil.example/sprite.svg#a"/>', /evil/],
    [
      'external images',
      '<image href="https://evil.example/pixel.png" width="1" height="1"/>',
      /evil|<image/,
    ],
    [
      'nested SVG documents as images',
      '<image href="data:image/svg+xml;base64,PHN2Zz4=" width="1" height="1"/>',
      /<image|svg\+xml/,
    ],
    ['external paint', '<rect width="1" height="1" fill="url(https://evil.example/x#p)"/>', /evil/],
    ['CSS imports', '<style>@import url(https://evil.example/x.css);</style>', /import|evil/],
    ['CSS external urls', '<style>rect{fill:url(https://evil.example/x)}</style>', /evil/],
    [
      'escaped CSS',
      '<rect style="fill:u\\72l(https://evil.example)" width="1" height="1"/>',
      /evil/,
    ],
    [
      'style attribute urls',
      '<rect style="filter:url(https://evil.example/f)" width="1" height="1"/>',
      /evil/,
    ],
    ['iframes', '<iframe src="https://evil.example"/>', /iframe|evil/],
    [
      'editor namespaces',
      '<sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"/>',
      /sodipodi/,
    ],
    [
      'metadata',
      '<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>',
      /metadata|rdf/,
    ],
    [
      'processing instructions',
      '<?xml-stylesheet href="https://evil.example/s.css"?><rect width="1" height="1"/>',
      /stylesheet|evil/,
    ],
    ['xml:base', '<g xml:base="https://evil.example/"><use xlink:href="#a"/></g>', /evil/],
  ])('removes %s', (_name, body, pattern) => {
    expect(clean(body)).not.toMatch(pattern);
  });

  it('keeps embedded raster images and the contents of links', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const svg = clean(
      `<image xlink:href="${png}" width="1" height="1"/><a href="https://example.org"><circle r="5"/></a>`,
    );
    expect(svg).toContain(png);
    expect(svg).toContain('<circle r="5"/>');
    expect(svg).not.toContain('example.org');
  });

  it('removes attributes on the root too', () => {
    const svg = clean(
      '<rect width="1" height="1"/>',
      ' onload="alert(1)" style="background:url(https://e.x)"',
    );
    expect(svg).not.toMatch(/onload|e\.x/);
  });

  it('refuses entity definitions (billion laughs, external entities)', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>${wrap('<text>&b;</text>')}`;
    expect(() => sanitizeSvg(laughs)).toThrow(SvgError);
    const external = `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${wrap('<text>&x;</text>')}`;
    expect(() => sanitizeSvg(external)).toThrow(SvgError);
  });

  it('accepts and drops a plain doctype', () => {
    const svg = sanitizeSvg(
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${wrap('<rect width="1" height="1"/>')}`,
    ).svg;
    expect(svg).not.toContain('DOCTYPE');
    expect(svg).toContain('<rect');
  });

  it('reads an SVG without a namespace, and always writes one', () => {
    const svg = sanitizeSvg('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>').svg;
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('refuses what isn’t an SVG, or has no size', () => {
    expect(() => sanitizeSvg('<html/>')).toThrow(SvgError);
    expect(() => sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/>')).toThrow(SvgError);
    expect(() => sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toThrow(
      'viewBox',
    );
  });
});
