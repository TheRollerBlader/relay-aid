import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {applyCommand} from '../shared/autonomy/engine.ts';
import {initialState, type Actor, type Command, type State} from '../shared/autonomy/contracts.ts';

const file = process.env.AUTONOMY_STATE_FILE || 'runtime/generated/autonomy-state.json';

function seed(state: State): State {
  state.stock['water-north'] = {id:'water-north', shelterId:'shelter-a', kind:'water', accessible:false, available:2, reserved:0, version:1};
  state.stock['water-south'] = {id:'water-south', shelterId:'shelter-b', kind:'water', accessible:false, available:6, reserved:0, version:1};
  state.stock['charge-north'] = {id:'charge-north', shelterId:'shelter-a', kind:'charging', accessible:false, available:1, reserved:0, version:1};
  state.stock['charge-north-access'] = {id:'charge-north-access', shelterId:'shelter-a', kind:'charging', accessible:true, available:1, reserved:0, version:1};
  state.stock['charge-south-access'] = {id:'charge-south-access', shelterId:'shelter-b', kind:'charging', accessible:true, available:1, reserved:0, version:1};
  state.profiles['synthetic-volunteer'] = {
    id:'synthetic-volunteer', role:'volunteer', orgId:'shelter-b', label:'Synthetic floor volunteer', language:'en',
    verified:true, active:true, guest:false, expiresAt:0, signedOn:true, skills:['water','charging'], skillsVerified:true,
  };
  state.services['synthetic-sandbox'] = {
    id:'synthetic-sandbox', name:'SYNTHETIC RESPONDER SANDBOX', orgId:'synthetic-org',
    categories:['medical','fire','flood','rescue','safety','utility','vehicle','food','shelter','other'],
    polygon:[[-125,24],[-66,24],[-66,50],[-125,50]],
    available:true, capacity:20, autoAccept:true, mode:'normal', delayMs:1500,
  };
  return state;
}

function load(): State {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as State;
  } catch {
    return seed(initialState());
  }
}

/** File-backed autonomy state for the local demo when Spacetime is not configured. */
export class LocalAutonomy {
  private state = load();
  private queue: Promise<void> = Promise.resolve();

  async snapshot(): Promise<State> {
    await this.queue;
    return structuredClone(this.state);
  }

  async command(actor: Actor, command: Command): Promise<unknown> {
    let result: unknown;
    const run = this.queue.then(() => {
      const applied = applyCommand(this.state, actor, command, Date.now());
      this.state = applied.state;
      result = applied.result;
      mkdirSync(dirname(file), {recursive:true});
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(this.state));
      renameSync(temp, file);
    });
    this.queue = run.then(() => undefined, () => undefined);
    await run;
    return result;
  }

  close() {}
}
