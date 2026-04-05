require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const postsRouter = require('./routes/posts');

const app = express();
app.use(cors());
app.use(express.json());


const MONGO_URI = process.env.MONGO_URI;
const SECRET_KEY = process.env.SECRET_KEY;

if (!MONGO_URI || !SECRET_KEY) {
  console.error('FATAL: MONGO_URI and SECRET_KEY must be set in environment variables.');
  process.exit(1);
}

MongoClient.connect(MONGO_URI)
  .then(client => {
    const db = client.db();
    // Make db accessible to all routes via app.locals
    app.locals.db = db;
    
    // Create indexes for performance at scale
    db.collection('posts').createIndex({ createdAt: -1 });
    db.collection('posts').createIndex({ authorId: 1 });
    db.collection('posts').createIndex({ privacy: 1 });
    db.collection('comments').createIndex({ postId: 1, createdAt: -1 });
    db.collection('replies').createIndex({ commentId: 1, createdAt: 1 });
    db.collection('users').createIndex({ email: 1 }, { unique: true });

    console.log('MongoDB connected. Indexes created.');
  })
  .catch(err => console.error('MongoDB connection error:', err));

// --- Auth Routes ---

// Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    const db = req.app.locals.db;
    const usersCollection = db.collection('users');

    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = { firstName, lastName, email, password: hashedPassword, createdAt: new Date() };
    const result = await usersCollection.insertOne(newUser);

    const token = jwt.sign(
      { userId: result.insertedId, firstName, lastName, email },
      SECRET_KEY,
      { expiresIn: '7d' }
    );
    res.status(201).json({ token, user: { id: result.insertedId, firstName, lastName, email } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = req.app.locals.db;
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email },
      SECRET_KEY,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// --- Posts Routes ---
app.use('/api/posts', postsRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
