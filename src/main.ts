import * as core from '@actions/core'
import * as github from '@actions/github'
import * as Webhooks from '@octokit/webhooks'
import {OctokitResponse, PullsGetResponseData} from '@octokit/types'

import * as process from 'process'
import * as util from 'util'

// ---------------------------------------------------------
// TODO
// - Make sure the PR isn't merged
//
// ---------------------------------------------------------

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
        if (issue.data.pull_request) {
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
          const fileMetadata = []

          for (const file of pr_files) {
            fileMetadata.push({status: file.status, filename: file.filename})
          }

          await githubClient.issues.createComment({
            issue_number: github.context.issue.number,
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            body: `Running base=${pr.data.base.sha} head=${
              pr.data.head.sha
            } files=${util.inspect(fileMetadata)}`
          })
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
