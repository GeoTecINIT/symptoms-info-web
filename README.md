# symptoms-info-web
Repository of the SyMptOMS landing page

Each section in the menu is an HTML page, and the Spanish version is inside the /es folder.

The content from publications and the posts is retrieved from the WordPress site of Geotec. /functions/src contains the scheduled (every 24 hours) functions that retrieve the WordPress content and save it to Firebase RTBD to make it accessible to the website.
Firebase hosting needs HTTPS enabled. If in the future Geotec Blog has HTTPS enabled it could be retrieved directly from the blog.
