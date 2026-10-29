import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import polars as pl
    import sqlite3

    return mo, pl, sqlite3


@app.cell
def _(mo):
    # Show file browser
    file_browser = mo.ui.file_browser(
        filetypes=[".db", ".sqlite", ".sqlite3"],
        multiple=False,
        restrict_navigation=False,
        label="Choose an sqlite database produced by the linkedin collector extension"
    )

    file_browser
    return (file_browser,)


@app.cell
def _(file_browser):
    assert len(file_browser.value) == 1
    file_browser.value[0].path
    return


@app.cell
def _(file_browser, pl, sqlite3):
    conn = sqlite3.connect(file_browser.value[0].path)
    conn
    df_posts = pl.read_database("SELECT * FROM posts",conn)
    df_posts
    return conn, df_posts


@app.cell
def _(conn, pl):
    df_images = pl.read_database("SELECT * FROM images",conn)
    df_post_images = pl.read_database("SELECT * FROM post_images",conn)
    return df_images, df_post_images


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    Filter for relevant posts using Jev
    """)
    return


@app.cell
def _(mo):
    api_key = mo.ui.text(
        label="OpenRouter API Key",
        placeholder="sk-or-v1-...",
        kind="password",
        full_width=True,
    )

    api_key
    return (api_key,)


@app.function
def combine_text(text,orig_text):
    if orig_text is None:
        combined_text = f"Linkedin post:{text}"
    else:
        combined_text = f"Mentioned post: {orig_text} Linkedin post:{text}"
    return combined_text


@app.cell
def _():
    from typesafe_sdk import AsyncTypeSafeClient, Choice

    CATEGORIES = [
        "PHD opening (computational biology or machine learning or AI)",
        "PHD opening (other fields)", 
        "Job opening",
        "other",
    ]
    QUESTIONS = {
        "categorize": Choice(
            instructions="Which category does this linkedin post fit?",
            criteria={c: None for c in CATEGORIES},
        ),
    }
    return AsyncTypeSafeClient, CATEGORIES, QUESTIONS


@app.cell
async def _(
    AsyncTypeSafeClient,
    CATEGORIES,
    QUESTIONS,
    api_key,
    df_posts,
    mo,
    pl,
):
    import asyncio

    mo.stop(not api_key.value, mo.md("Enter an OpenRouter API key to classify the posts."))

    MAX_CONCURRENCY = 16
    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    states = [combine_text(t, o) for t, o in zip(df_posts["text"], df_posts["orig_text"])]

    async with AsyncTypeSafeClient(api_key=api_key.value, base_url="https://openrouter.ai/api") as client:
        async def categorize(state):
            async with sem:
                response = await client.system_one(state=state, questions=QUESTIONS)
            return response.answers["categorize"].probabilities

        with mo.status.progress_bar(total=len(states), title="Classifying posts") as bar:
            async def tracked(state):
                result = await categorize(state)
                bar.update()
                return result

            results = await asyncio.gather(*(tracked(s) for s in states))

    df_w_categories = df_posts.with_columns(
        pl.Series("result", [{c: r.get(c) for c in CATEGORIES} for r in results])
    )
    return (df_w_categories,)


@app.cell
def _(CATEGORIES, mo):
    sort_col_choose = mo.ui.dropdown(CATEGORIES,value=CATEGORIES[0],label="Choose category")
    sort_col_choose
    return (sort_col_choose,)


@app.cell
def _(df_posts, df_w_categories, pl, sort_col_choose):
    SORT_COL = sort_col_choose.value
    RELEVANCE_CUTOFF = 0.70

    df_w_categories_unnested_sorted_filtered=(
        df_w_categories
            .unnest()
            .sort(SORT_COL,descending=True)
            .filter(pl.col(SORT_COL)>RELEVANCE_CUTOFF)
    )
    f"{df_w_categories_unnested_sorted_filtered.height} posts were classified with confidence higher than {RELEVANCE_CUTOFF} out of {df_posts.height} posts ({1-(df_w_categories_unnested_sorted_filtered.height/df_posts.height):.0%} filtered)"
    return (df_w_categories_unnested_sorted_filtered,)


@app.cell
def _(df_w_categories_unnested_sorted_filtered, mo):
    record = mo.ui.slider(
        start=0,
        stop=df_w_categories_unnested_sorted_filtered.height - 1,
        step=1,
        value=0,
        label="Post",
        show_value=True,
    )

    record
    return (record,)


@app.cell
def _(df_images, df_post_images, mo, pl):
    def get_img(posid):
        matches = df_post_images.filter(pl.col("post_id") == posid)

        if matches.is_empty():
            return None

        img_hash = matches.item(0, "sha256")

        img_matches = df_images.filter(pl.col("sha256") == img_hash)

        if img_matches.is_empty():
            return None

        img_bytes = img_matches.item(0, "bytes")
        return mo.image(img_bytes, width=500)

    return (get_img,)


@app.cell
def _(
    df_w_categories_unnested_sorted_filtered,
    get_img,
    mo,
    record,
    sort_col_choose,
):
    def display_record(df, index: int):
        row = df.row(index, named=True)

        return mo.vstack([
            mo.md(f"### Post {index + 1} / {df.height}"),
            mo.md(f"```Probability: {row[sort_col_choose.value]: .2%}```"),
            mo.md(f"{row['text']}"),
            (f"Mention> {row['orig_text']}") if row['orig_text'] else "",
            get_img(row["id"]) if get_img(row["id"]) else ""
        ])
    display_record(df_w_categories_unnested_sorted_filtered, record.value)
    return


@app.cell
def _(mo):
    mo.vstack(["",]*100)
    return


if __name__ == "__main__":
    app.run()
