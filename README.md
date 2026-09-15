# symptoms-info-web
Repository of the SyMptOMS landing page

Each section in the menu is a page. Pages are **generated**: sources live in
`src/`, and `build.mjs` renders them into `dist/`, which is what Firebase Hosting
serves. English page bodies are in `src/pages/`, Spanish in `src/pages/es/`, and
the header/nav/footer/script list they share exist once in `src/site.config.json`
and `src/partials/`.

```bash
node build.mjs            # build src/ -> dist/
node build.mjs --watch    # rebuild on change while working
node build.mjs --check    # verify every page has both an EN and an ES version
npx serve dist            # preview locally
```

There is nothing to install — the build uses only the Node standard library.
See [src/README.md](src/README.md) for how to add a page or a nav link.

The content from publications and the posts is retrieved from the WordPress site of Geotec. /functions/src contains the scheduled (every 24 hours) functions that retrieve the WordPress content and save it to Firebase RTBD to make it accessible to the website.
Firebase hosting needs HTTPS enabled. If in the future Geotec Blog has HTTPS enabled it could be retrieved directly from the blog.
