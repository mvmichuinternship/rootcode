import * as assert from 'node:assert/strict';
import { WorkflowRunner, tuningSteps, taskSteps, type WorkflowEvent } from '../workflow';

suite('Demo workflow', () => {
	test('Runs the five tuning stages and stops at pipeline handoff', async () => {
		const events: WorkflowEvent[] = [];
		await new WorkflowRunner(event => events.push(event), 0).start('tuning');
		assert.deepEqual(events.filter(event => event.type === 'progress').map(event => event.step), [0, 1, 2, 3, 4]);
		assert.equal(tuningSteps.length, 5);
		assert.equal(events.at(-1)?.type, 'complete');
		assert.match(events.at(-1)?.message ?? '', /No data was collected or uploaded/);
	});

	test('Runs a task workflow without claiming agent execution', async () => {
		const events: WorkflowEvent[] = [];
		await new WorkflowRunner(event => events.push(event), 0).start('task', 'Add tests');
		assert.equal(events.filter(event => event.type === 'progress').length, taskSteps.length);
		assert.match(events.at(-1)?.message ?? '', /Add tests/);
		assert.match(events.at(-1)?.message ?? '', /No agent has run/);
	});

	test('Cancellation prevents completion and allows another run', async () => {
		const events: WorkflowEvent[] = [];
		const runner = new WorkflowRunner(event => events.push(event), 0);
		const first = runner.start('tuning');
		runner.cancel();
		await first;
		assert.equal(events.at(-1)?.type, 'cancelled');
		assert.ok(!events.some(event => event.type === 'complete'));
		await runner.start('task', 'Try again');
		assert.equal(events.at(-1)?.type, 'complete');
	});

	test('Ignores overlapping starts and disposes pending timers', async () => {
		const events: WorkflowEvent[] = [];
		const runner = new WorkflowRunner(event => events.push(event), 10000);
		const pending = runner.start('tuning');
		await runner.start('task', 'Duplicate');
		runner.dispose();
		await pending;
		assert.deepEqual(events, [{ type: 'progress', kind: 'tuning', step: 0 }]);
	});
});