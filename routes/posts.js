const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const authMiddleware = require('../middleware/authMiddleware');


const getDb = (req) => req.app.locals.db;


const getAuthorFromUser = (user) => ({
  id: user.userId.toString(),
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
});


router.post('/', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const { content, privacy = 'public', imageUrl = null } = req.body;

    if (!content && !imageUrl) {
      return res.status(400).json({ message: 'Post must have content or an image' });
    }

    if (!['public', 'private'].includes(privacy)) {
      return res.status(400).json({ message: 'Invalid privacy value' });
    }

    // Fetch author info from DB
    const usersCollection = db.collection('users');
    const userId = new ObjectId(req.user.userId);
    const author = await usersCollection.findOne({ _id: userId }, { projection: { password: 0 } });

    const newPost = {
      authorId: userId,
      authorName: `${author.firstName} ${author.lastName}`,
      content: content || '',
      imageUrl,           // ImgBB CDN URL sent from frontend, or null
      privacy,
      likes: [],
      commentsCount: 0,
      createdAt: new Date()
    };

    const postsCollection = db.collection('posts');
    const result = await postsCollection.insertOne(newPost);

    res.status(201).json({ ...newPost, _id: result.insertedId });
  } catch (err) {
    console.error('Create post error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- GET /api/posts - Get all visible posts (newest first, paginated) ---
router.get('/', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const postsCollection = db.collection('posts');
    const currentUserId = req.user.userId.toString();

    // Pagination
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    // Filter: public posts OR author's own private posts
    const filter = {
      $or: [
        { privacy: 'public' },
        { authorId: new ObjectId(currentUserId), privacy: 'private' }
      ]
    };

    const posts = await postsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // Add isLiked flag for current user
    const enriched = posts.map(post => ({
      ...post,
      isLiked: post.likes.includes(currentUserId),
      likesCount: post.likes.length
    }));

    const total = await postsCollection.countDocuments(filter);

    res.json({ posts: enriched, total, page, limit });
  } catch (err) {
    console.error('Get posts error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- PUT /api/posts/:id/privacy - Update post privacy ---
router.put('/:id/privacy', authMiddleware, async (req, res) => {
  console.log(`Privacy update request: ID=${req.params.id}, Body=${JSON.stringify(req.body)}`);
  try {
    const db = getDb(req);
    const postsCollection = db.collection('posts');
    const postId = new ObjectId(req.params.id);
    const currentUserId = req.user.userId.toString();
    const { privacy } = req.body;

    if (!['public', 'private'].includes(privacy)) {
      return res.status(400).json({ message: 'Invalid privacy value' });
    }

    const post = await postsCollection.findOne({ _id: postId });
    if (!post) return res.status(404).json({ message: 'Post not found' });

    // Only author can change privacy
    if (post.authorId.toString() !== currentUserId) {
      return res.status(403).json({ message: 'Only the author can change privacy' });
    }

    await postsCollection.updateOne({ _id: postId }, { $set: { privacy } });
    res.json({ privacy });
  } catch (err) {
    console.error('Update privacy error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- PUT /api/posts/:id/like - Toggle like on a post ---
router.put('/:id/like', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const postsCollection = db.collection('posts');
    const postId = new ObjectId(req.params.id);
    const currentUserId = req.user.userId.toString();

    const post = await postsCollection.findOne({ _id: postId });
    if (!post) return res.status(404).json({ message: 'Post not found' });

    // Privacy check
    if (post.privacy === 'private' && post.authorId.toString() !== currentUserId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const hasLiked = post.likes.includes(currentUserId);
    const update = hasLiked
      ? { $pull: { likes: currentUserId } }
      : { $push: { likes: currentUserId } };

    await postsCollection.updateOne({ _id: postId }, update);

    res.json({ liked: !hasLiked, likesCount: hasLiked ? post.likes.length - 1 : post.likes.length + 1 });
  } catch (err) {
    console.error('Like post error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- GET /api/posts/:id/likes - Who liked this post ---
router.get('/:id/likes', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const postsCollection = db.collection('posts');
    const usersCollection = db.collection('users');
    const postId = new ObjectId(req.params.id);
    const currentUserId = req.user.userId.toString();

    const post = await postsCollection.findOne({ _id: postId });
    if (!post) return res.status(404).json({ message: 'Post not found' });

    if (post.privacy === 'private' && post.authorId.toString() !== currentUserId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const likerIds = post.likes.map(id => new ObjectId(id));
    const likers = await usersCollection
      .find({ _id: { $in: likerIds } }, { projection: { firstName: 1, lastName: 1, email: 1 } })
      .toArray();

    res.json({ likers });
  } catch (err) {
    console.error('Get likes error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- POST /api/posts/:id/comments - Add a comment ---
router.post('/:id/comments', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const postsCollection = db.collection('posts');
    const commentsCollection = db.collection('comments');
    const usersCollection = db.collection('users');
    const postId = new ObjectId(req.params.id);
    const currentUserId = req.user.userId.toString();
    const { content } = req.body;

    if (!content) return res.status(400).json({ message: 'Comment content is required' });

    const post = await postsCollection.findOne({ _id: postId });
    if (!post) return res.status(404).json({ message: 'Post not found' });

    if (post.privacy === 'private' && post.authorId.toString() !== currentUserId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const author = await usersCollection.findOne(
      { _id: new ObjectId(currentUserId) },
      { projection: { firstName: 1, lastName: 1 } }
    );

    const newComment = {
      postId,
      authorId: new ObjectId(currentUserId),
      authorName: `${author.firstName} ${author.lastName}`,
      content,
      likes: [],
      repliesCount: 0,
      createdAt: new Date()
    };

    const result = await commentsCollection.insertOne(newComment);
    await postsCollection.updateOne({ _id: postId }, { $inc: { commentsCount: 1 } });

    res.status(201).json({ ...newComment, _id: result.insertedId });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- GET /api/posts/:id/comments - Get comments for a post ---
router.get('/:id/comments', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const postsCollection = db.collection('posts');
    const commentsCollection = db.collection('comments');
    const postId = new ObjectId(req.params.id);
    const currentUserId = req.user.userId.toString();

    const post = await postsCollection.findOne({ _id: postId });
    if (!post) return res.status(404).json({ message: 'Post not found' });

    if (post.privacy === 'private' && post.authorId.toString() !== currentUserId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    const comments = await commentsCollection
      .find({ postId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const enriched = comments.map(c => ({
      ...c,
      isLiked: c.likes.includes(currentUserId),
      likesCount: c.likes.length
    }));

    res.json({ comments: enriched });
  } catch (err) {
    console.error('Get comments error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- PUT /api/posts/:id/comments/:commentId/like - Toggle like on a comment ---
router.put('/:id/comments/:commentId/like', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const commentsCollection = db.collection('comments');
    const commentId = new ObjectId(req.params.commentId);
    const currentUserId = req.user.userId.toString();

    const comment = await commentsCollection.findOne({ _id: commentId });
    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    const hasLiked = comment.likes.includes(currentUserId);
    const update = hasLiked
      ? { $pull: { likes: currentUserId } }
      : { $push: { likes: currentUserId } };

    await commentsCollection.updateOne({ _id: commentId }, update);
    res.json({ liked: !hasLiked, likesCount: hasLiked ? comment.likes.length - 1 : comment.likes.length + 1 });
  } catch (err) {
    console.error('Like comment error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- POST /api/posts/:id/comments/:commentId/replies - Add reply ---
router.post('/:id/comments/:commentId/replies', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const commentsCollection = db.collection('comments');
    const repliesCollection = db.collection('replies');
    const usersCollection = db.collection('users');
    const commentId = new ObjectId(req.params.commentId);
    const currentUserId = req.user.userId.toString();
    const { content } = req.body;

    if (!content) return res.status(400).json({ message: 'Reply content is required' });

    const comment = await commentsCollection.findOne({ _id: commentId });
    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    const author = await usersCollection.findOne(
      { _id: new ObjectId(currentUserId) },
      { projection: { firstName: 1, lastName: 1 } }
    );

    const newReply = {
      commentId,
      postId: comment.postId,
      authorId: new ObjectId(currentUserId),
      authorName: `${author.firstName} ${author.lastName}`,
      content,
      likes: [],
      createdAt: new Date()
    };

    const result = await repliesCollection.insertOne(newReply);
    await commentsCollection.updateOne({ _id: commentId }, { $inc: { repliesCount: 1 } });

    res.status(201).json({ ...newReply, _id: result.insertedId });
  } catch (err) {
    console.error('Add reply error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- GET /api/posts/:id/comments/:commentId/replies - Get replies ---
router.get('/:id/comments/:commentId/replies', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const repliesCollection = db.collection('replies');
    const commentId = new ObjectId(req.params.commentId);
    const currentUserId = req.user.userId.toString();

    const replies = await repliesCollection
      .find({ commentId })
      .sort({ createdAt: 1 })
      .toArray();

    const enriched = replies.map(r => ({
      ...r,
      isLiked: r.likes.includes(currentUserId),
      likesCount: r.likes.length
    }));

    res.json({ replies: enriched });
  } catch (err) {
    console.error('Get replies error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- PUT /api/posts/:id/comments/:commentId/replies/:replyId/like - Toggle like on reply ---
router.put('/:id/comments/:commentId/replies/:replyId/like', authMiddleware, async (req, res) => {
  try {
    const db = getDb(req);
    const repliesCollection = db.collection('replies');
    const replyId = new ObjectId(req.params.replyId);
    const currentUserId = req.user.userId.toString();

    const reply = await repliesCollection.findOne({ _id: replyId });
    if (!reply) return res.status(404).json({ message: 'Reply not found' });

    const hasLiked = reply.likes.includes(currentUserId);
    const update = hasLiked
      ? { $pull: { likes: currentUserId } }
      : { $push: { likes: currentUserId } };

    await repliesCollection.updateOne({ _id: replyId }, update);
    res.json({ liked: !hasLiked, likesCount: hasLiked ? reply.likes.length - 1 : reply.likes.length + 1 });
  } catch (err) {
    console.error('Like reply error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
