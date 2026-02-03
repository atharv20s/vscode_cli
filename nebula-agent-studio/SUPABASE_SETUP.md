# Supabase Setup Guide for AgenticCLI

## Step 1: Create a Supabase Project

1. Go to [https://supabase.com](https://supabase.com)
2. Click "Start your project" and sign in with GitHub
3. Click "New Project"
4. Choose your organization (or create one)
5. Fill in:
   - **Project name**: `agentic-cli`
   - **Database Password**: Generate a strong password (save it!)
   - **Region**: Choose the closest to you
6. Click "Create new project" and wait ~2 minutes

## Step 2: Get Your API Keys

1. In your project dashboard, click **Settings** (gear icon) → **API**
2. Copy these values:
   - **Project URL**: `https://xxxxxxxx.supabase.co`
   - **anon public key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

## Step 3: Create Your .env File

Create a file called `.env` in the `nebula-agent-studio` folder:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

## Step 4: Enable Google OAuth

1. In Supabase dashboard, go to **Authentication** → **Providers**
2. Find **Google** and click to expand
3. Toggle **Enable Google** to ON
4. You need to set up Google OAuth credentials:

### Setting up Google OAuth:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Go to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth client ID**
5. Choose **Web application**
6. Add these:
   - **Authorized JavaScript origins**: `http://localhost:5173`
   - **Authorized redirect URIs**: `https://YOUR_SUPABASE_PROJECT.supabase.co/auth/v1/callback`
7. Copy the **Client ID** and **Client Secret**
8. Paste them in Supabase Google provider settings
9. Click **Save**

## Step 5: Enable GitHub OAuth

1. In Supabase dashboard, go to **Authentication** → **Providers**
2. Find **GitHub** and click to expand
3. Toggle **Enable GitHub** to ON

### Setting up GitHub OAuth:
1. Go to [GitHub Settings → Developer settings → OAuth Apps](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in:
   - **Application name**: `AgenticCLI`
   - **Homepage URL**: `http://localhost:5173`
   - **Authorization callback URL**: `https://YOUR_SUPABASE_PROJECT.supabase.co/auth/v1/callback`
4. Click **Register application**
5. Copy **Client ID** and generate a **Client Secret**
6. Paste them in Supabase GitHub provider settings
7. Click **Save**

## Step 6: Set Up Site URL

1. In Supabase, go to **Authentication** → **URL Configuration**
2. Set:
   - **Site URL**: `http://localhost:5173`
   - **Redirect URLs**: Add `http://localhost:5173`

## Step 7: Create Database Tables (Optional)

For storing user projects and files, run this SQL in **SQL Editor**:

```sql
-- User projects table
CREATE TABLE projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project files table
CREATE TABLE files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT,
  language TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;

-- Policies for projects
CREATE POLICY "Users can view own projects" ON projects
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create projects" ON projects
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects" ON projects
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects" ON projects
  FOR DELETE USING (auth.uid() = user_id);

-- Policies for files
CREATE POLICY "Users can view files in own projects" ON files
  FOR SELECT USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can create files in own projects" ON files
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update files in own projects" ON files
  FOR UPDATE USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete files in own projects" ON files
  FOR DELETE USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );
```

## Step 8: Restart Your Dev Server

After creating the `.env` file:
```bash
cd nebula-agent-studio
npm run dev
```

## Troubleshooting

### "Supabase credentials not found" warning
- Make sure your `.env` file is in the `nebula-agent-studio` folder
- Variable names must start with `VITE_`
- Restart the dev server after creating `.env`

### OAuth not redirecting properly
- Check that redirect URLs match exactly in both Google/GitHub and Supabase
- Make sure Site URL is set in Supabase Authentication settings

### User shows as "User" instead of name
- For Google: The name is stored in `user_metadata.full_name`
- For GitHub: The name is stored in `user_metadata.name` or `user_metadata.preferred_username`
- The app automatically fetches these from Supabase

## Next Steps

Once Supabase is set up, you can:
1. Sign in with Google/GitHub and see your real name
2. Store user projects in the database
3. Build the IDE feature to create and run files
