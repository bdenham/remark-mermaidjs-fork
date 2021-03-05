import { resolve } from 'path';
import { pathToFileURL } from 'url';

import * as fromParse5 from 'hast-util-from-parse5';
// eslint-disable-next-line import/no-unresolved
import { Code, Parent } from 'mdast';
import { Mermaid } from 'mermaid';
import { parseFragment } from 'parse5';
import { Browser, launch, LaunchOptions, Page } from 'puppeteer';
import * as SVGO from 'svgo';
import { Attacher } from 'unified';
import * as visit from 'unist-util-visit';

type Theme = 'dark' | 'default' | 'forest' | 'neutral';

declare const mermaid: Mermaid;

export const defaultSVGOOptions: SVGO.Options = {
  js2svg: {
    indent: 2,
    pretty: true,
  },
  multipass: true,
  plugins: [
    { cleanupAttrs: true },
    { removeViewBox: true },
    { inlineStyles: { onlyMatchedOnce: false } },
    { convertStyleToAttrs: true },
    { removeStyleElement: true },
    { cleanupIDs: { force: true } },
    { removeAttrs: { attrs: ['class'] } },
    { removeUnknownsAndDefaults: true },
    { removeUselessDefs: true },
    {
      removeHiddenElems: {
        isHidden: true,
        displayNone: true,
        opacity0: true,
        circleR0: true,
        ellipseRX0: true,
        ellipseRY0: true,
        rectWidth0: true,
        rectHeight0: true,
        patternWidth0: true,
        patternHeight0: true,
        imageWidth0: true,
        imageHeight0: true,
        pathEmptyD: true,
        polylineEmptyPoints: true,
        polygonEmptyPoints: true,
      },
    },
    { removeEmptyContainers: true },
    { collapseGroups: true },
    { sortAttrs: true },
  ],
};

export interface RemarkMermaidOptions {
  /**
   * Launc options to pass to puppeteer.
   *
   * @default {}
   */
  launchOptions?: LaunchOptions;

  /**
   * SVGO options used to minify the SVO output.
   *
   * Set to `null` explicitly to disable this.
   *
   * @default defaultSVGOOptions
   */
  svgo?: SVGO.Options | null;

  /**
   * The Mermaod theme to use.
   *
   * @default 'default'
   */
  theme?: Theme;
}

/**
 * @param options - Options that may be used to tweak the output.
 */
export const remarkMermaid: Attacher<[RemarkMermaidOptions?]> = ({
  launchOptions = { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  svgo = defaultSVGOOptions,
  theme = 'default',
} = {}) => {
  const optimizer = svgo && new SVGO(svgo);
  let browserPromise: Promise<Browser> | undefined;
  let count = 0;

  return async function transformer(ast) {
    const instances: [string, number, Parent][] = [];

    visit<Code>(ast, { type: 'code', lang: 'mermaid' }, (node, index, parent) => {
      instances.push([node.value, index, parent as Parent]);
    });

    // Nothing to do. No need to start puppeteer in this case.
    if (!instances.length) {
      return ast;
    }

    count += 1;
    browserPromise ??= launch(launchOptions);
    const browser = await browserPromise;
    let page: Page | undefined;
    try {
      page = await browser.newPage();
      await page.goto(String(pathToFileURL(resolve(__dirname, '..', 'index.html'))));
      await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min') });
      await page.setViewport({ width: 600, height: 3000 });

      const results = await page.evaluate(
        // We can’t calculate coverage on this function, as it’s run by Chrome, not Jest.
        /* istanbul ignore next */
        (codes: string[], t: Theme) =>
          codes.map((code) => {
            const id = 'a';
            mermaid.initialize({ theme: t });
            const div = document.createElement('div');
            div.innerHTML = mermaid.render(id, code);
            return div.innerHTML;
          }),
        instances.map((instance) => instance[0]),
        theme,
      );
      await Promise.all(
        instances.map(async ([, index, parent], i) => {
          let value = results[i];
          if (optimizer) {
            value = (await optimizer.optimize(value)).data;
          }
          parent.children.splice(index, 1, {
            type: 'paragraph',
            children: [{ type: 'html', value }],
            data: { hChildren: [fromParse5(parseFragment(value))] },
          });
        }),
      );
    } finally {
      count -= 1;
      await page?.close();
    }
    if (!count) {
      browserPromise = undefined;
      await browser?.close();
    }

    return ast;
  };
};
