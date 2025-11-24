import { readdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = './data/stats_viralmind';
const GUAC_DIR = '/Volumes/SSD-Ext/Viralmind-2025-06-28/S3/guac';

// Progress bar utility
function showProgress(current: number, total: number, label: string) {
  const percentage = Math.round((current / total) * 100);
  const barLength = 40;
  const filledLength = Math.round((percentage / 100) * barLength);
  const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
  
  process.stdout.write(`\r${label}: [${bar}] ${percentage}% (${current}/${total})`);
  
  if (current === total) {
    console.log(); // New line when complete
  }
}

(async () => {
  try {
    console.log('📊 ViralMind Stats Analysis Starting...\n');

    // Read race sessions from JSON file
    console.log('📁 Loading race sessions...');
    const sessionsFile = await Bun.file(join(DATA_DIR, 'viralmind.race_sessions.json')).json();
    const sessions = Array.isArray(sessionsFile) ? sessionsFile : [];
    const TOTAL_SESSIONS = sessions.length;
    console.log(`✅ Loaded ${TOTAL_SESSIONS.toLocaleString()} sessions\n`);

    // Forge Usage Stats
    const uniqueUsers = new Set(sessions.map((session) => session.address)).size;

    // Challenge popularity
    const challengeCounts: Record<string, number> = sessions.reduce(
      (acc, session) => {
        acc[session.challenge] = (acc[session.challenge] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const sortedChallenges = Object.entries(challengeCounts)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .map(([challenge, count]) => `${challenge}: ${count}`);

    // Application analysis from prompts
    const applicationCounts: Record<string, number> = {};
    const applicationRewards: Record<string, number> = {};
    const applicationVideoMinutes: Record<string, number> = {};
    const applicationInputEvents: Record<string, number> = {};
    const applicationTextPrompts: Record<string, number> = {};
    const applicationPatterns = {
      'jspaint.app': /jspaint\.app/i,
      'LibreOffice Calc': /LibreOffice Calc/i,
      'VS Code': /VS Code/i,
      'Audacity': /Audacity/i,
      'Ubuntu desktop': /Ubuntu desktop/i,
      'browser IDE': /browser IDE/i,
      'miniwob++': /miniwob\+\+|miniwob\.farama\.org/i,
      'browser games': /browser games/i,
      'rapid-fire clicking': /rapid-fire clicking/i,
      'probability-based games': /probability-based.*game/i,
      'clicking challenges': /clicking challenges/i,
      'Excel': /Excel/i,
      'Word': /Word/i,
      'PowerPoint': /PowerPoint/i,
      'Photoshop': /Photoshop/i,
      'GIMP': /GIMP/i,
      'Blender': /Blender/i,
      'Chrome': /Chrome/i,
      'Firefox': /Firefox/i,
      'Terminal': /Terminal|command line|bash|shell/i,
      'Notepad': /Notepad/i,
      'Calculator': /Calculator/i,
      'File Manager': /File Manager|Explorer|Finder/i,
      'YouTube': /YouTube/i,
      'Discord': /Discord/i,
      'Slack': /Slack/i,
      'Figma': /Figma/i,
      'Sketch': /Sketch/i,
      'InDesign': /InDesign/i,
      'Premiere': /Premiere/i,
      'After Effects': /After Effects/i,
      'Minecraft': /Minecraft/i,
      'Steam': /Steam/i,
      'Unity': /Unity/i,
      'Unreal': /Unreal/i,
      'coding challenge': /coding challenge/i,
      'spreadsheet': /spreadsheet/i,
      'budget': /budget/i,
      'audio mixing': /mix audio|audio mixing/i,
      'drawing/painting': /draw|cartoon|character/i,
      'desktop challenges': /desktop challenges/i,
      'web browsing': /browse|web|website/i,
      'file management': /file.*manage|folder|directory/i,
      'text editing': /text edit|document/i,
      'video editing': /video edit/i,
      'image editing': /image edit|photo edit/i
    };

    // Create session to app mapping
    console.log('🔍 Analyzing session prompts and mapping applications...');
    const sessionToApp: Record<string, string> = {};
    
    sessions.forEach((session, index) => {
      if (index % 1000 === 0) {
        showProgress(index, sessions.length, 'Mapping applications');
      }
      const sessionId = session._id?.$oid || session._id;
      let appName = '';
      
      if (session.prompt) {
        let foundApp = false;
        for (const [name, pattern] of Object.entries(applicationPatterns)) {
          if (pattern.test(session.prompt)) {
            appName = name;
            foundApp = true;
            break;
          }
        }
        if (!foundApp) {
          appName = `${session.challenge} (other)`;
        }
      } else {
        appName = `${session.challenge} (other)`;
      }
      
      sessionToApp[sessionId] = appName;
      applicationCounts[appName] = (applicationCounts[appName] || 0) + 1;
      
      // Calculate video minutes per app
      const createdAt = session.created_at?.$date || session.created_at;
      const updatedAt = session.updated_at?.$date || session.updated_at;
      
      if (createdAt && updatedAt) {
        const start = new Date(createdAt).getTime();
        const end = new Date(updatedAt).getTime();
        const minutes = (end - start) / (1000 * 60);
        applicationVideoMinutes[appName] = (applicationVideoMinutes[appName] || 0) + minutes;
      }
    });
    showProgress(sessions.length, sessions.length, 'Mapping applications');
    console.log();


    // Demonstration Data Stats
    let textPrompts = 0;
    let videoMinutes = 0;
    let keyboardEvents = 0;
    let mouseEvents = 0;
    let rewardEvents = 0;
    let totalRewards = 0;

    // Read training events from JSON file
    console.log('📝 Loading training events...');
    const trainingEventsFile = await Bun.file(join(DATA_DIR, 'viralmind.training_events.json')).json();
    const trainingEvents = Array.isArray(trainingEventsFile) ? trainingEventsFile : [];
    console.log(`✅ Loaded ${trainingEvents.length.toLocaleString()} training events\n`);

    // Process training events
    console.log('⚡ Processing training events and calculating rewards...');
    trainingEvents.forEach((event, index) => {
      if (index % 10000 === 0) {
        showProgress(index, trainingEvents.length, 'Processing events');
      }
      // Count all text prompts per app
      const sessionId = event.session;
      const appName = sessionToApp[sessionId];
      if (appName) {
        applicationTextPrompts[appName] = (applicationTextPrompts[appName] || 0) + 1;
      }
      
      if (event.type === 'reward') {
        rewardEvents++;
        const rewardValue = event.metadata?.rewardValue || 0;
        totalRewards += rewardValue;
        
        // Associate reward with app
        if (appName) {
          applicationRewards[appName] = (applicationRewards[appName] || 0) + rewardValue;
        }
      }
    });
    showProgress(trainingEvents.length, trainingEvents.length, 'Processing events');
    console.log();

    textPrompts = trainingEvents.length;

    // Process guac files for input events
    console.log('🎮 Processing guac files for input events...');
    console.log('⚠️  This may take a while - processing large files from external SSD\n');
    
    let processedGuacs = 0;
    let foundGuacs = 0;
    
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const sessionId = session._id?.$oid || session._id;
      const appName = sessionToApp[sessionId];
      const guacFile = join(GUAC_DIR, `${sessionId}.guac`);
      
      if (i % 100 === 0) {
        showProgress(i, sessions.length, `Scanning guac files (found: ${foundGuacs})`);
      }
      
      if (await Bun.file(guacFile).exists()) {
        foundGuacs++;
        try {
          // Read file in chunks to handle large files
          const content = await Bun.file(guacFile).text();
          const instructions = content.split(';');
          let sessionKeyEvents = 0;
          let sessionMouseEvents = 0;

          instructions.forEach((instruction) => {
            if (!instruction.trim()) return;
            const parts = instruction.trim().split(',');
            if (parts.length === 0) return;

            // Simple opcode extraction
            const opMatch = parts[0].match(/^\d+\.(\w+)/);
            if (!opMatch) return;
            const opcode = opMatch[1];

            if (opcode === 'key') {
              keyboardEvents++;
              sessionKeyEvents++;
            } else if (opcode === 'mouse') {
              mouseEvents++;
              sessionMouseEvents++;
            }
          });
          
          // Associate input events with app
          if (appName) {
            applicationInputEvents[appName] = (applicationInputEvents[appName] || 0) + sessionKeyEvents + sessionMouseEvents;
          }
          
          processedGuacs++;
          if (processedGuacs % 10 === 0) {
            console.log(`\n📊 Processed ${processedGuacs}/${foundGuacs} guac files...`);
          }
        } catch (e) {
          console.error(`\n❌ Error processing ${guacFile}:`, e.message);
        }
      }
    }
    showProgress(sessions.length, sessions.length, `Scanning guac files (found: ${foundGuacs})`);
    console.log(`\n✅ Processed ${processedGuacs} guac files with input events\n`);

    // Calculate total video minutes
    videoMinutes = Object.values(applicationVideoMinutes).reduce((sum, minutes) => sum + minutes, 0);

    console.log('🏁 Analysis Complete! Generating Results...\n');
    console.log('═'.repeat(60));
    console.log('\n=== Forge Usage ===');
    console.log(`Sessions: ${TOTAL_SESSIONS}`);
    console.log(`Unique Users: ${uniqueUsers}`);

    console.log('\nChallenge Distribution:');
    sortedChallenges.forEach((c) => {
      const [name, count] = c.split(':');
      console.log(`${name.trim()}: ${count.trim()}`);
    });

    console.log('\n=== Application Detailed Stats ===');
    const appNames = Object.keys(applicationCounts).sort((a, b) => applicationCounts[b] - applicationCounts[a]);
    
    appNames.forEach((appName) => {
      const sessions = applicationCounts[appName] || 0;
      const rewards = applicationRewards[appName] || 0;
      const minutes = Math.round(applicationVideoMinutes[appName] || 0);
      const inputs = applicationInputEvents[appName] || 0;
      const prompts = applicationTextPrompts[appName] || 0;
      
      console.log(`\n${appName}:`);
      console.log(`  • Sessions: ${sessions.toLocaleString()}`);
      console.log(`  • Text prompts: ${prompts.toLocaleString()}`);
      console.log(`  • Rewards: ${rewards.toLocaleString()} $VIRAL`);
      console.log(`  • Video: ${minutes.toLocaleString()} minutes`);
      console.log(`  • Input events: ${inputs.toLocaleString()}`);
    });

    console.log('\n=== Rewards Data ===');
    console.log(`• ${rewardEvents.toLocaleString()} reward events`);
    console.log(`• ${totalRewards.toLocaleString()} total rewards`);

    console.log('\n=== Demonstration Data ===');
    console.log('Input:');
    console.log(`• ${textPrompts.toLocaleString()} text prompts`);
    console.log(`• ${videoMinutes.toLocaleString()} minutes of video`);

    console.log('\nOutput (User Actions):');
    console.log(`• ${keyboardEvents.toLocaleString()} keyboard events`);
    console.log(`• ${mouseEvents.toLocaleString()} mouse events`);
    console.log(`• ${(keyboardEvents + mouseEvents).toLocaleString()} total user actions`);
  } catch (error) {
    console.error('Error:', error);
  }
})();
