import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'

import * as Webhooks from '@octokit/webhooks'
import {OctokitResponse, PullsGetResponseData} from '@octokit/types'

import * as prettier from 'prettier'

import * as process from 'process'
import {promises as fs} from 'fs'

async function run(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token', {required: true})
    if (github.context.eventName === 'issue_comment') {
      const payload = github.context
        .payload as Webhooks.EventPayloads.WebhookPayloadIssueComment

      // handle the case that an issue body was edited, didn't previously match, and now it does...
      const command = testComment(payload.comment.body)
      if (command === PrettierPleaseCommand.Prettier && !payload.changes) {
        const githubClient = github.getOctokit(githubToken)
        // make sure the issue is a PR, we can't just use the issue from the payload,
        // since this does not distinguish between issues and PRs
        const issue = await githubClient.issues.get({
          issue_number: github.context.issue.number,
          owner: github.context.repo.owner,
          repo: github.context.repo.repo
        })
        // make sure the Issue is also a Pull Request, and that it's 'open'
        if (issue.data.pull_request && issue.data.state === 'open') {
          const pr = (await githubClient.request(
            issue.data.pull_request.url
          )) as OctokitResponse<PullsGetResponseData>

          const pr_files = await githubClient.paginate(
            githubClient.pulls.listFiles,
            {
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              pull_number: pr.data.number,
              per_page: 100
            }
          )
          const filesToFormat = []

          for (const file of pr_files) {
            if (
              (file.status === 'added' || file.status === 'modified') &&
              file.filename.endsWith('.md')
            ) {
              filesToFormat.push(file.filename)
            }
          }

          await exec.exec('git', ['fetch', 'origin', pr.data.head.ref])
          await exec.exec('git', ['checkout', pr.data.head.ref])

          for (const filename of filesToFormat) {
            const fileContents = (await fs.readFile(filename)).toString()
            const formatted = prettier.format(fileContents, {
              parser: 'markdown'
            })
            await fs.writeFile(filename, formatted)
          }

          await exec.exec('git', ['config', 'user.name', 'github-actions[bot]'])
          await exec.exec('git', [
            'config',
            'user.email',
            'github-actions[bot]@users.noreply.github.com'
          ])
          await exec.exec('git', ['add'].concat(filesToFormat))

          // see if we made any changes
          const madeChanges = await exec.exec(
            'git',
            ['diff', '--cached', '--quiet'],
            {ignoreReturnCode: true}
          )

          if (madeChanges === 1) {
            await exec.exec('git', [
              'commit',
              '-m',
              'Format markdown files with Prettier'
            ])
            await exec.exec('git', ['push'])
          } else {
            await githubClient.issues.createComment({
              issue_number: github.context.issue.number,
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              body: `Prettier ran, but didn't make any changes to the files you added/modified.`
            })
          }
        } else {
          // Not a pull request
          core.debug(`Ran, but this was an Issue, and not a Pull Request`)
        }
      } else {
        // A command was not parsed, do nothing
        core.debug(`Comment did not contain a command, exiting`)
        process.exit()
      }
    } else {
      core.error(
        `Event type was of unsupported type: ${github.context.eventName}`
      )
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

enum PrettierPleaseCommand {
  Prettier,
  Nothing
}

function testComment(comment: string): PrettierPleaseCommand {
  if (comment.trim().startsWith('prettier, please!')) {
    return PrettierPleaseCommand.Prettier
  } else {
    return PrettierPleaseCommand.Nothing
  }
}

run()
