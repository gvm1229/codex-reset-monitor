export function deduplicatePosts(posts) {
  return [...new Map(posts.map((post) => [post.id, post])).values()];
}
