const functions = require("firebase-functions");
const admin = require("firebase-admin");
const jsdom = require("jsdom");
const nodeFetch = require("node-fetch");
const {JSDOM} = jsdom;
const bibtexParser = require("bib2json");

const defaultApp = admin.initializeApp();

const rtdb = defaultApp.database();

// const bucket = storage.getStorage().bucket();

const BLOG_POSTS_URL = "http://geotec.uji.es/wp-json/wp/v2/posts?_embed&tags=203";
const PUBLICATIONS_URL = "http://geotec.uji.es/?feed=tp_pub_bibtex&tag=445";

exports.scheduledSavePublications = functions.pubsub.schedule("every 24 hours").onRun(async () => {
    const refPubs = rtdb.ref("publications");
    const response = await nodeFetch(PUBLICATIONS_URL);
    const data = await response.text();

    const entries = bibtexParser(data);
    // console.log(entries);

    // Save publications to bbdd
    refPubs.set(entries);
});

exports.scheduledSaveBlogPosts = functions.pubsub.schedule("every 24 hours").onRun(async () => {
    const refPosts = rtdb.ref("geotecblog");
    const response = await nodeFetch(BLOG_POSTS_URL);
    const data = await response.json();

    // save all posts data to bbdd
    // refPosts.set(data).catch((error) => {
    //     functions.logger.error(error);
    //     console.log(error);
    // });


    const refLastUpdated = rtdb.ref("lastUpdated");

    refLastUpdated.on("value", (snapshot: any) => {
        console.log("last Updated");
        let lastUpdated = snapshot.val();
        console.log(lastUpdated);
        data.forEach(async (blogpost: any, index: number) => {
            // If there is a new or modified post
            if (blogpost.modified > lastUpdated) {
                // actualizar last modified
                refLastUpdated.set(blogpost.modified);
                lastUpdated = blogpost.modified;
                console.log("last Updated modified");
                console.log(lastUpdated);

                // Save new blog post to bbdd
                refPosts.child(index).set(blogpost);

                // get post featured image
                const postImage = blogpost._embedded["wp:featuredmedia"][0];

                // Upload featured image to firebase storage and save public url to bbdd
                if (postImage.source_url) {
                    const img = await nodeFetch(postImage.source_url);
                    const imgData = await img.arrayBuffer();
                    const uint8 = new Uint8Array(imgData);

                    admin
                        .storage()
                        .bucket()
                        .file("img/" + postImage.slug + ".jpg")
                        .save(uint8)
                        .catch((err: any) => {
                            console.error("ERROR:", err);
                        });

                    admin
                        .storage()
                        .bucket()
                        .file("img/" + postImage.slug + ".jpg")
                        .getSignedUrl({
                            action: "read",
                            expires: "12-01-2045",
                        })
                        .then((results: any[]) => {
                            const signedUrl = results[0];
                            console.log(`The signed URL for is ${signedUrl}`);
                            refPosts.child(index).update({imgurl: signedUrl});
                        })
                        .catch((err: any) => {
                            console.error("ERROR:", err);
                        });
                }
            }
        });
    }, (errorObject: {name: string}) => {
        console.log("The read failed: " + errorObject.name);
    });
});

exports.saveBlogPostsImgs = functions.database.ref("/geotecblog/{blogIndex}/content/rendered").onCreate((snapshot: any, context: any) => {
    // Grab the current value of what was written to the Realtime Database.
    const originalContent = snapshot.val();
    console.log("Content has an http image");

    // content includes insecure http image
    if (originalContent.includes("<img src=\"http://")) {
        const dom = new JSDOM(originalContent);
        const document = dom.window.document;

        document.querySelectorAll("img").forEach(async (element: { src: string }, index: number) => {
            if (element.src.includes("http:")) {
                console.log("Index img http:  ");
                console.log(index);
                console.log(element.src);

                const img = await nodeFetch(element.src);
                const imgData = await img.arrayBuffer();
                const uint8 = new Uint8Array(imgData);

                const nameArray = element.src.split("/");
                const name = nameArray[nameArray.length - 1];
                const noExtArray = name.split(".");
                const noExtName = noExtArray[0];

                console.log("name no ext  ");
                console.log(noExtName);

                admin
                    .storage()
                    .bucket()
                    .file("postimg/post" + context.params.blogIndex + "-" + noExtName + ".jpg")
                    .save(uint8)
                    .catch((err: any) => {
                        console.error("ERROR:", err);
                    });

                admin
                    .storage()
                    .bucket()
                    .file("postimg/post" + context.params.blogIndex + "-" + noExtName + ".jpg")
                    .getSignedUrl({
                        action: "read",
                        expires: "12-01-2045",
                    })
                    .then((results: any[]) => {
                        const signedUrl = results[0];
                        console.log(`The signed URL img post for is ${signedUrl}`);
                        document.querySelectorAll("img")[index].src = signedUrl;

                        // save new content with secure img url to bbdd
                        snapshot.ref.set(document.documentElement.outerHTML);
                    })
                    .catch((err: any) => {
                        console.error("ERROR:", err);
                    });
            }
        });
    }
});
