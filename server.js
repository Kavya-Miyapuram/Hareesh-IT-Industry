require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Fees are decided here on the server (rupees per team)
const FEES = {
  cricket: Number(process.env.CRICKET_FEE) || 3499,
  kabaddi: Number(process.env.KABADDI_FEE) || 1999
};
const PAY_NUMBER = (process.env.PAY_NUMBER || '8297297632').trim();

const teamSchema = new mongoose.Schema({
  captain:  { type: String, required: true, trim: true, maxlength: 80 },
  contact:  { type: String, required: true, match: /^[6-9]\d{9}$/ },
  email:    { type: String, required: true, trim: true, lowercase: true,
              match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  college:  { type: String, required: true, trim: true, maxlength: 120 },
  year:     { type: Number, required: true, enum: [1, 2, 3, 4] },          // captain's engineering year
  sport:    { type: String, required: true, enum: ['cricket', 'kabaddi'] },
  utr:      { type: String, required: true, trim: true, uppercase: true, unique: true,
              match: /^[A-Z0-9]{10,25}$/ },                                // UPI transaction ID entered by the captain
  amount:   Number,                                                        // rupees
  status:   { type: String, enum: ['pending', 'paid'], default: 'pending' }, // paid = verified by admin
  paidAt:   Date
}, { timestamps: true });
teamSchema.index({ email: 1, sport: 1 }, { unique: true });                // one team per captain email per sport

const Team = mongoose.model('Team', teamSchema);

function isAdmin(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false;
  const a = Buffer.from(req.get('x-admin-key') || ''), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Public: fees + payment number shown on the form ----
app.get('/api/payment-info', (req, res) => res.json({ fees: FEES, payNumber: PAY_NUMBER }));

// ---- Public: captain registers a team (stays "pending" until the admin verifies the payment) ----
app.post('/api/register', async (req, res) => {
  try {
    const { captain, contact, email, college, year, utr, isCaptain } = req.body;
    const sport = String(req.body.sport || '').toLowerCase();
    if (!isCaptain)
      return res.status(400).json({ error: 'Only the team captain can register the team.' });
    if (!FEES[sport])
      return res.status(400).json({ error: 'Please select a valid sport.' });

    await Team.create({
      captain, contact, email, college, year: Number(year), sport,
      utr: String(utr || '').trim(), amount: FEES[sport], status: 'pending'
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === 11000) {
      const keys = Object.keys(err.keyPattern || {});
      return res.status(409).json({ error: keys.includes('utr')
        ? 'This transaction ID has already been used.'
        : 'A team has already been registered with this email for this sport.' });
    }
    if (err.name === 'ValidationError')
      return res.status(400).json({ error: 'Please check all fields (10-digit mobile number and a valid transaction ID).' });
    console.error(err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---- Admin only ----
app.get('/api/teams', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Invalid admin key.' });
  const teams = await Team.find().sort({ createdAt: -1 }).lean();
  res.json({
    teams: teams.map(t => ({
      id: t._id, captain: t.captain, contact: t.contact, email: t.email,
      college: t.college, year: t.year, sport: t.sport, utr: t.utr,
      amount: t.amount || 0, status: t.status === 'paid' ? 'paid' : 'pending',
      registeredAt: t.createdAt
    }))
  });
});

app.patch('/api/teams/:id/verify', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Invalid admin key.' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  const t = await Team.findByIdAndUpdate(req.params.id, { status: 'paid', paidAt: new Date() }, { new: true });
  if (!t) return res.status(404).json({ error: 'Team not found.' });
  res.json({ ok: true });
});

app.delete('/api/teams/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Invalid admin key.' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  const removed = await Team.findByIdAndDelete(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Team not found.' });
  res.json({ ok: true });
});

if (!process.env.ADMIN_KEY) console.warn('WARNING: ADMIN_KEY is not set. The admin page will be inaccessible.');

const port = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => app.listen(port, () => console.log('Running on port ' + port)))
  .catch(err => { console.error('MongoDB connection failed:', err.message); process.exit(1); });
